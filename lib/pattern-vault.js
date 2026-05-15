'use strict';

// pattern-vault — shared utilities for the Recall-Pattern markdown
// vault format defined in RECALL-PATTERN.md.
//
// Used by:
//   - `recall pattern-validate` (lib/commands/pattern-validate.js)
//       reads a vault, runs schema + relationship + drift checks,
//       returns a health score and findings list.
//   - `recall import-vault`     (lib/commands/import-vault.js)
//       reuses readVault() and validateEntry() so import and validate
//       agree on what a "valid" vault entry looks like.
//
// The pattern vault has a simpler schema than the engine's MIF v4.0.
// import-vault adapts pattern → MIF; validate works in pattern space.

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['sources', 'node_modules', '.git', '.recall', 'evals', '.vscode', '.idea']);
// Internal sentinels written by the engine (one per project). They have
// no user-facing name/description, and treating them as entries makes
// every engine-imported vault report `_index` as a duplicate id N times.
const SKIP_FILES = new Set(['_index.json']);
const VALID_RELATIONSHIP_TYPES = new Set([
  'supersedes', 'contradicts', 'confirms', 'qualifies', 'deprecates', 'child_of',
]);
// Canonical status enum — reconciled against:
//   - RECALL-PATTERN.md (active|closed|superseded|disputed)
//   - real engine data at ~/.recall/kb/* (active|retired|superseded|closed|disabled)
// Final set: union minus engine-only `disabled` (legacy outlier; should
// migrate to `retired`). `draft` removed — unused in real data.
const VALID_STATUSES = new Set(['active', 'retired', 'superseded', 'closed', 'disputed']);

// --------------------------------------------------------------------------
// Reading the vault
// --------------------------------------------------------------------------

function readVault(vaultDir) {
  const resolved = path.resolve(vaultDir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`vault directory not found: ${resolved}`);
  }

  const entries = [];
  const categories = new Map(); // categoryName -> count
  const items = fs.readdirSync(resolved, { withFileTypes: true });

  for (const item of items) {
    if (!item.isDirectory()) continue;
    if (SKIP_DIRS.has(item.name)) continue;
    const categoryDir = path.join(resolved, item.name);
    const files = fs.readdirSync(categoryDir, { withFileTypes: true });
    for (const f of files) {
      if (!f.isFile()) continue;
      if (!f.name.endsWith('.json')) continue;
      if (SKIP_FILES.has(f.name)) continue;
      const fullPath = path.join(categoryDir, f.name);
      const raw = fs.readFileSync(fullPath, 'utf8');
      const entry = { _path: fullPath, _category: item.name, _file: f.name };
      try {
        const parsed = JSON.parse(raw);
        Object.assign(entry, parsed);
        // Backfill category + id if missing — same as import-vault does
        if (!entry.category) entry.category = item.name;
        if (!entry.id) entry.id = f.name.replace(/\.json$/, '');
      } catch (err) {
        entry._parseError = err.message;
        entry._rawHead = raw.slice(0, 200);
      }
      entries.push(entry);
      categories.set(item.name, (categories.get(item.name) || 0) + 1);
    }
  }

  const relationships = readRelationships(resolved);
  return {
    vaultDir: resolved,
    entries,
    relationships,
    categories: Array.from(categories.entries()).map(([name, count]) => ({ name, count })),
  };
}

function readRelationships(vaultDir) {
  const filePath = path.join(vaultDir, 'relationships.jsonl');
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) return [];
  return raw.split('\n').filter((line) => line.trim()).map((line, idx) => {
    const rel = { _line: idx + 1 };
    try {
      Object.assign(rel, JSON.parse(line));
    } catch (err) {
      rel._parseError = err.message;
      rel._raw = line.slice(0, 200);
    }
    return rel;
  });
}

// --------------------------------------------------------------------------
// Entry validation
// --------------------------------------------------------------------------

// Returns an array of finding objects describing what's wrong with
// the entry (or [] if it's clean).
function validateEntry(entry) {
  const findings = [];
  const at = entry._path || entry.id || '(unknown)';

  if (entry._parseError) {
    findings.push({
      level: 'error', code: 'parse_error', at,
      detail: entry._parseError,
    });
    return findings; // can't validate further if it didn't parse
  }

  if (!entry.id || typeof entry.id !== 'string') {
    findings.push({ level: 'error', code: 'missing_id', at });
  } else if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(entry.id) && entry.id.length >= 2) {
    findings.push({
      level: 'warn', code: 'bad_id_format', at,
      detail: `id "${entry.id}" should be kebab-case (lowercase letters, digits, hyphens)`,
    });
  } else if (entry.id.length < 2) {
    findings.push({
      level: 'error', code: 'bad_id_format', at,
      detail: `id "${entry.id}" is too short (minimum 2 chars)`,
    });
  }

  if (!entry.name || typeof entry.name !== 'string' || !entry.name.trim()) {
    findings.push({ level: 'error', code: 'missing_name', at });
  }

  if (!entry.description || typeof entry.description !== 'string' || !entry.description.trim()) {
    findings.push({ level: 'error', code: 'missing_description', at });
  } else if (entry.description.trim().length < 10) {
    findings.push({
      level: 'warn', code: 'short_description', at,
      detail: `description is only ${entry.description.trim().length} chars (drift signal)`,
    });
  }

  if (entry.status !== undefined && !VALID_STATUSES.has(entry.status)) {
    findings.push({
      level: 'warn', code: 'invalid_status', at,
      detail: `status "${entry.status}" not in ${Array.from(VALID_STATUSES).join('/')}`,
    });
  }

  if (entry.confidence !== undefined) {
    if (typeof entry.confidence !== 'number' || Number.isNaN(entry.confidence)) {
      findings.push({
        level: 'warn', code: 'invalid_confidence', at,
        detail: `confidence "${entry.confidence}" is not a number`,
      });
    } else if (entry.confidence < 0 || entry.confidence > 1) {
      findings.push({
        level: 'warn', code: 'invalid_confidence', at,
        detail: `confidence ${entry.confidence} outside [0,1]`,
      });
    }
  }

  if (entry.sources !== undefined && !Array.isArray(entry.sources)) {
    findings.push({
      level: 'warn', code: 'non_array_sources', at,
      detail: `sources should be an array; got ${typeof entry.sources}`,
    });
  }

  if (entry.tags !== undefined && !Array.isArray(entry.tags)) {
    findings.push({
      level: 'warn', code: 'non_array_tags', at,
      detail: `tags should be an array; got ${typeof entry.tags}`,
    });
  }

  return findings;
}

// --------------------------------------------------------------------------
// Relationship validation (depends on knowing the full entry set)
// --------------------------------------------------------------------------

function validateRelationships(relationships, entries) {
  const entryIds = new Set(entries.filter((e) => !e._parseError && e.id).map((e) => e.id));
  const findings = [];

  for (const r of relationships) {
    const at = `relationships.jsonl:${r._line}`;
    if (r._parseError) {
      findings.push({
        level: 'error', code: 'relationship_parse_error', at,
        detail: r._parseError,
      });
      continue;
    }
    if (!r.from) {
      findings.push({ level: 'error', code: 'relationship_missing_from', at });
    } else if (!entryIds.has(r.from)) {
      findings.push({
        level: 'warn', code: 'relationship_dangling_from', at,
        detail: `from="${r.from}" does not exist in vault`,
      });
    }
    if (!r.to) {
      findings.push({ level: 'error', code: 'relationship_missing_to', at });
    } else if (!entryIds.has(r.to)) {
      findings.push({
        level: 'warn', code: 'relationship_dangling_to', at,
        detail: `to="${r.to}" does not exist in vault`,
      });
    }
    if (!r.type) {
      findings.push({ level: 'error', code: 'relationship_missing_type', at });
    } else if (!VALID_RELATIONSHIP_TYPES.has(r.type)) {
      findings.push({
        level: 'error', code: 'relationship_invalid_type', at,
        detail: `type "${r.type}" not in ${Array.from(VALID_RELATIONSHIP_TYPES).join('/')}`,
      });
    }
    if (r.from && r.to && r.from === r.to) {
      findings.push({
        level: 'warn', code: 'relationship_self_loop', at,
        detail: `from === to === "${r.from}"`,
      });
    }
  }

  return findings;
}

// --------------------------------------------------------------------------
// Duplicate detection
// --------------------------------------------------------------------------

function findDuplicateIds(entries) {
  const seen = new Map(); // id -> [paths]
  for (const e of entries) {
    if (!e.id || e._parseError) continue;
    if (!seen.has(e.id)) seen.set(e.id, []);
    seen.get(e.id).push(e._path);
  }
  const findings = [];
  for (const [id, paths] of seen) {
    if (paths.length > 1) {
      findings.push({
        level: 'error', code: 'duplicate_id', at: paths[0],
        detail: `id "${id}" used by ${paths.length} entries: ${paths.join(', ')}`,
      });
    }
  }
  return findings;
}

// --------------------------------------------------------------------------
// Drift signals (informational, don't block — but score affects health)
// --------------------------------------------------------------------------

function detectDriftSignals(entries, relationships, categories) {
  const findings = [];
  const validEntries = entries.filter((e) => !e._parseError && e.id);

  // Orphan ratio: entries with no incoming AND no outgoing relationships.
  // Only meaningful if the vault HAS relationships to begin with — a vault
  // with zero relationships triggers a false 100% orphan rate that obscures
  // real findings. Engine-format vaults store relationships inline per
  // entry (not in relationships.jsonl); detect those too so the drift
  // signal fires on real disconnection, not on schema-format mismatch.
  if (validEntries.length > 0) {
    const linkedIds = new Set();
    for (const r of relationships) {
      if (r._parseError) continue;
      if (r.from) linkedIds.add(r.from);
      if (r.to) linkedIds.add(r.to);
    }
    let inlineRelCount = 0;
    for (const e of validEntries) {
      if (!Array.isArray(e.relationships)) continue;
      for (const ir of e.relationships) {
        inlineRelCount++;
        const from = ir && (ir.from || e.id);
        const to = ir && ir.to;
        if (from) linkedIds.add(from);
        if (to) linkedIds.add(to);
      }
    }
    const totalRelationships = relationships.length + inlineRelCount;
    if (totalRelationships > 0) {
      const orphanCount = validEntries.filter((e) => !linkedIds.has(e.id)).length;
      const orphanRatio = orphanCount / validEntries.length;
      if (validEntries.length >= 10 && orphanRatio > 0.7) {
        findings.push({
          level: 'info', code: 'high_orphan_ratio',
          at: '(vault)',
          detail: `${orphanCount}/${validEntries.length} entries (${Math.round(orphanRatio * 100)}%) have no relationships. The discipline is decaying.`,
        });
      }
    }
  }

  // Confidence clustering: if every entry has the same confidence value,
  // confidence is being ignored
  const withConfidence = validEntries.filter((e) => typeof e.confidence === 'number');
  if (withConfidence.length >= 10) {
    const values = withConfidence.map((e) => e.confidence);
    const unique = new Set(values);
    if (unique.size === 1) {
      findings.push({
        level: 'info', code: 'confidence_not_calibrated',
        at: '(vault)',
        detail: `all ${withConfidence.length} entries have confidence=${values[0]}. Field is not being used.`,
      });
    }
  }

  // Empty categories: tiny categories may indicate abandoned threads
  for (const c of categories) {
    if (c.count === 1 && validEntries.length >= 20) {
      findings.push({
        level: 'info', code: 'singleton_category',
        at: c.name,
        detail: `category "${c.name}" has only 1 entry`,
      });
    }
  }

  return findings;
}

// --------------------------------------------------------------------------
// Health score
// --------------------------------------------------------------------------

// Per-finding severity weights. Higher = more damaging to the score.
const FINDING_WEIGHTS = {
  parse_error: 10,
  duplicate_id: 8,
  missing_id: 8,
  missing_name: 5,
  missing_description: 5,
  bad_id_format: 3,
  invalid_status: 2,
  invalid_confidence: 2,
  non_array_sources: 1,
  non_array_tags: 1,
  short_description: 1,
  relationship_parse_error: 4,
  relationship_missing_from: 3,
  relationship_missing_to: 3,
  relationship_missing_type: 3,
  relationship_invalid_type: 3,
  relationship_dangling_from: 2,
  relationship_dangling_to: 2,
  relationship_self_loop: 1,
  high_orphan_ratio: 10,
  confidence_not_calibrated: 5,
  singleton_category: 2,
};

function computeHealth(findings, entryCount, relationshipCount = 0) {
  if (entryCount === 0) return 0;
  // Drift = total finding weight divided by total items (entries +
  // relationships). Normalizing makes the score meaningful at both small
  // and large vault sizes — a 200-entry vault with 5 errors is not in
  // the same shape as a 5-entry vault with 5 errors, but a fixed
  // deduction would treat them identically.
  const denom = Math.max(1, entryCount + Math.max(0, relationshipCount));
  let totalWeight = 0;
  for (const f of findings) {
    totalWeight += FINDING_WEIGHTS[f.code] || 1;
  }
  const driftPerItem = totalWeight / denom;
  // driftPerItem of 0   → score 100
  // driftPerItem of 0.5 → score 50  (significant drift)
  // driftPerItem of 1.0+ → score 0  (every item has a full-weight finding)
  const deduction = Math.min(100, driftPerItem * 100);
  return Math.round(Math.max(0, 100 - deduction));
}

function classifyHealth(score) {
  if (score >= 90) return { tier: 'excellent', label: 'Excellent — disciplined vault, ready to import.' };
  if (score >= 70) return { tier: 'good',      label: 'Good — minor cleanup recommended before import.' };
  if (score >= 50) return { tier: 'fair',      label: 'Fair — significant drift; consider repair pass.' };
  if (score >= 30) return { tier: 'poor',      label: 'Poor — vault has structural problems; repair before import.' };
  return                  { tier: 'critical',  label: 'Critical — vault is corrupt or empty. Do not import.' };
}

// --------------------------------------------------------------------------
// Top-level: run all checks
// --------------------------------------------------------------------------

function validateVault(vaultDir) {
  const { entries, relationships, categories, vaultDir: resolved } = readVault(vaultDir);

  const findings = [];
  for (const e of entries) {
    findings.push(...validateEntry(e));
  }
  findings.push(...findDuplicateIds(entries));
  findings.push(...validateRelationships(relationships, entries));
  findings.push(...detectDriftSignals(entries, relationships, categories));

  const errorCount = findings.filter((f) => f.level === 'error').length;
  const warnCount  = findings.filter((f) => f.level === 'warn').length;
  const infoCount  = findings.filter((f) => f.level === 'info').length;

  const score = computeHealth(findings, entries.length, relationships.length);
  const health = classifyHealth(score);

  return {
    vaultDir: resolved,
    entryCount: entries.length,
    cleanEntries: entries.filter((e) => !e._parseError && e.id).length,
    relationshipCount: relationships.length,
    cleanRelationships: relationships.filter((r) => !r._parseError && r.from && r.to && VALID_RELATIONSHIP_TYPES.has(r.type)).length,
    categories,
    errorCount,
    warnCount,
    infoCount,
    healthScore: score,
    healthTier: health.tier,
    healthLabel: health.label,
    findings,
  };
}

module.exports = {
  // constants
  SKIP_DIRS,
  VALID_RELATIONSHIP_TYPES,
  VALID_STATUSES,
  // reading
  readVault,
  readRelationships,
  // per-piece validation
  validateEntry,
  validateRelationships,
  findDuplicateIds,
  detectDriftSignals,
  // scoring
  computeHealth,
  classifyHealth,
  // one-shot
  validateVault,
};
