'use strict';

// recall import-vault — ingest a Recall-Pattern markdown vault into
// the real Recall engine.
//
// The Recall Pattern (RECALL-PATTERN.md) is a self-contained markdown
// vault format that works with just Claude Code, no engine required.
// When users outgrow that and install the full engine, this command
// is the upgrade path: walks the vault and inserts every entry +
// relationship into the SQLite-backed KB.
//
// Layout the command expects (per RECALL-PATTERN.md):
//
//   <vault>/
//   ├── CLAUDE.md                          (the pattern itself; not imported)
//   ├── decisions/
//   │   ├── <id>.md                        (description; not parsed)
//   │   └── <id>.json                      (the entry metadata — THIS is imported)
//   ├── lessons/, features/, todos/, ...
//   ├── relationships.jsonl                (one JSON line per relation)
//   └── sources/                           (immutable raw sources; not imported as KB entries)
//
// Validation pipeline (added 0.26.0):
//   1. Read vault, score health via lib/pattern-vault.js.
//   2. If health < 30 (critical) and no --force, refuse to import.
//   3. For each entry: skip if it has validation ERRORS unless --repair
//      can auto-fix them. Warnings always pass.
//   4. For relationships: skip dangling endpoints, log them in the report.
//   5. Produce a structured report (clean / repaired / rejected /
//      duplicates / dangling) so the user sees what actually happened.

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const meridian = require('../meridian-core');
const cliConfig = require('../cli-config');
const pv = require('../pattern-vault');

function inferProjectId(vaultDir, fallback) {
  // Use folder basename if it looks like a project id (kebab-case),
  // else use the supplied fallback.
  const base = path.basename(path.resolve(vaultDir));
  if (/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(base)) return base;
  return fallback || 'imported-vault';
}

// --------------------------------------------------------------------------
// Repair strategies — only applied when --repair is set. Returns the
// (possibly modified) entry plus a list of repairs that were applied so
// the report can show what changed.
// --------------------------------------------------------------------------
function repairEntry(entry, findings) {
  const repairs = [];
  const out = { ...entry };

  for (const f of findings) {
    if (f.code === 'missing_name' && out.id) {
      out.name = String(out.id);
      repairs.push('used id as name');
    }
    if (f.code === 'missing_description' && (out.name || out.id)) {
      out.description = String(out.name || out.id);
      repairs.push('used name as description');
    }
    if (f.code === 'invalid_confidence') {
      out.confidence = 0.5;
      repairs.push('clamped confidence to 0.5');
    }
    if (f.code === 'non_array_sources') {
      out.sources = out.sources ? [String(out.sources)] : [];
      repairs.push('wrapped sources scalar in array');
    }
    if (f.code === 'non_array_tags') {
      out.tags = [];
      repairs.push('dropped non-array tags');
    }
    if (f.code === 'invalid_status') {
      out.status = 'active';
      repairs.push('reset status to active');
    }
    if (f.code === 'bad_id_format' && out.id) {
      // Kebab-case the id (must keep _ in the first pass so it can become -)
      const repaired = String(out.id)
        .toLowerCase()
        .replace(/[^a-z0-9\s_-]/g, '')
        .trim()
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      if (repaired && repaired.length >= 2) {
        out.id = repaired;
        repairs.push(`kebab-cased id → "${repaired}"`);
      }
    }
  }

  return { entry: out, repairs };
}

// Errors that can be repaired in --repair mode. Errors not in this set
// (e.g. parse_error, missing_id without a fallback) cannot be salvaged.
const REPAIRABLE_CODES = new Set([
  'missing_name', 'missing_description', 'invalid_confidence',
  'non_array_sources', 'non_array_tags', 'invalid_status', 'bad_id_format',
]);

function isRepairable(findings) {
  if (findings.length === 0) return true;
  return findings.every((f) => REPAIRABLE_CODES.has(f.code) || f.level !== 'error');
}

// --------------------------------------------------------------------------
// Pattern entry → MIF v4.0 adapter
// --------------------------------------------------------------------------
// Engine ids must match ^[a-z0-9][a-z0-9-]*[a-z0-9]$ — kebab-case the
// pattern-vault id on the way in. Pattern-vault ids that would otherwise
// be rejected (spaces, uppercase, underscores) are normalized so the
// import doesn't lose entries the validator only marked as warnings.
function normalizeIdForEngine(id) {
  if (!id || typeof id !== 'string') return id;
  const k = id
    .toLowerCase()
    // Keep alphanumerics, whitespace, hyphens, and underscores. The
    // underscore must survive this step so the next step can convert
    // it to a hyphen — otherwise "use_typescript" becomes "usetypescript"
    // instead of "use-typescript".
    .replace(/[^a-z0-9\s_-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return k.length >= 2 ? k : id;
}

function buildMifFields(entry, nowIso) {
  const confidenceValue = typeof entry.confidence === 'number' ? entry.confidence : 0.8;
  const sourcesArray = Array.isArray(entry.sources) ? entry.sources : (entry.sources ? [entry.sources] : []);
  const extensions = { importedFromPatternVault: true };
  if (sourcesArray.length) extensions.patternVaultSources = sourcesArray;
  if (entry.supersededBy) extensions.patternVaultSupersededBy = entry.supersededBy;
  const normalizedId = normalizeIdForEngine(entry.id);
  if (normalizedId !== entry.id) {
    extensions.patternVaultOriginalId = entry.id;
  }

  // Pattern-vault accepts a wider status enum than MIF v4.0. Map them so
  // user intent isn't silently coerced to 'active':
  //   superseded → retired  (lifecycle equivalent)
  //   closed     → retired  (no longer in play)
  //   disputed   → active + _extensions.disputed: true (still in play, contested)
  //   anything unrecognized → active, but stash the original under _extensions
  const MIF_STATUSES = new Set(['active', 'retired', 'draft']);
  let mifStatus;
  if (MIF_STATUSES.has(entry.status)) {
    mifStatus = entry.status;
  } else if (entry.status === 'superseded' || entry.status === 'closed') {
    mifStatus = 'retired';
    extensions.patternVaultStatus = entry.status;
  } else if (entry.status === 'disputed') {
    mifStatus = 'active';
    extensions.patternVaultStatus = 'disputed';
  } else {
    mifStatus = 'active';
    if (entry.status) extensions.patternVaultStatus = entry.status;
  }

  const fields = {
    id: normalizedId,
    name: entry.name || normalizedId,
    description: entry.description || entry.name || normalizedId,
    category: entry._category || entry.category,
    status: mifStatus,
    confidence: {
      value: Math.max(0, Math.min(1, confidenceValue)),
      lastVerified: nowIso,
      verificationStatus: 'unverified',
    },
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    _extensions: extensions,
  };
  if (sourcesArray[0] && typeof sourcesArray[0] === 'string') {
    fields.source = sourcesArray[0];
  }
  return fields;
}

// --------------------------------------------------------------------------
// CLI wiring
// --------------------------------------------------------------------------
module.exports = function(program) {
  program
    .command('import-vault <vault-dir>')
    .description('Import a Recall-Pattern markdown vault (see RECALL-PATTERN.md) into the engine. Validates first, then imports. Re-imports are idempotent.')
    .option('--project <id>', 'Override project id (default: inferred from vault folder name)')
    .option('--dry-run', 'Validate + show plan without writing to the KB')
    .option('--validate-only', 'Alias for --dry-run (matches `recall pattern-validate` framing)')
    .option('--repair', 'Auto-fix recoverable issues (missing name/description, bad confidence, non-array fields, kebab-case ids)')
    .option('--force', 'Import even when vault health is critical (score < 30)')
    .option('--skip-relationships', 'Import entries only; skip relationships.jsonl')
    .option('--json', 'Print report as JSON')
    .action(async (vaultDir, opts) => {
      try {
        const resolved = path.resolve(vaultDir);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
          throw new Error(`vault directory not found: ${resolved}`);
        }
        const validateOnly = Boolean(opts.dryRun || opts.validateOnly);
        const repair = Boolean(opts.repair);
        const force = Boolean(opts.force);

        // 1. Read + validate
        const vault = pv.readVault(resolved);
        const validation = pv.validateVault(resolved);
        const projectId = opts.project || inferProjectId(resolved);

        // 2. Refuse to import if critical health and not forced
        if (!validateOnly && validation.healthScore < 30 && !force) {
          const msg = `Refusing to import: vault health is critical (${validation.healthScore}/100). Re-run with --validate-only to see the findings, --repair to auto-fix what's recoverable, or --force to import anyway.`;
          if (opts.json) {
            console.log(JSON.stringify({ ok: false, outcome: 'refused', validation, error: msg }, null, 2));
          } else {
            console.error(chalk.red(msg));
          }
          process.exitCode = 1;
          return;
        }

        // 3. Classify each entry: clean, repaired, or rejected
        const entryClassification = [];
        const findingsByPath = new Map();
        for (const f of validation.findings) {
          if (!f.at) continue;
          if (!findingsByPath.has(f.at)) findingsByPath.set(f.at, []);
          findingsByPath.get(f.at).push(f);
        }

        const nowIso = new Date().toISOString();

        for (const entry of vault.entries) {
          const entryFindings = (findingsByPath.get(entry._path) || []).filter((f) => f.level === 'error');
          if (entry._parseError) {
            entryClassification.push({
              kind: 'rejected', reason: 'parse_error', entry, findings: entryFindings,
            });
            continue;
          }
          if (entryFindings.length === 0) {
            entryClassification.push({ kind: 'clean', entry, findings: [] });
            continue;
          }
          // Entry has errors. Repairable?
          if (repair && isRepairable(entryFindings)) {
            const { entry: repaired, repairs } = repairEntry(entry, entryFindings);
            entryClassification.push({
              kind: 'repaired', entry: repaired, repairs, findings: entryFindings,
            });
            continue;
          }
          entryClassification.push({
            kind: 'rejected',
            reason: repair ? 'unrepairable_errors' : 'has_errors',
            entry,
            findings: entryFindings,
          });
        }

        // 4. Classify relationships: clean / dangling / rejected
        // Remap both sides through the same id-normalization the engine
        // adapter applies, otherwise relationships pointing at a
        // normalized entry id (e.g. "USE-FOO" → "use-foo") would all go
        // dangling. Build a set of *normalized* ids to check against.
        const validEntryIds = new Set(
          entryClassification
            .filter((c) => c.kind === 'clean' || c.kind === 'repaired')
            .map((c) => normalizeIdForEngine(c.entry.id)),
        );

        const relClassification = [];
        for (const r of vault.relationships) {
          if (r._parseError) {
            relClassification.push({ kind: 'rejected', reason: 'parse_error', rel: r });
            continue;
          }
          if (!r.from || !r.to || !r.type) {
            relClassification.push({ kind: 'rejected', reason: 'missing_field', rel: r });
            continue;
          }
          if (!pv.VALID_RELATIONSHIP_TYPES.has(r.type)) {
            relClassification.push({ kind: 'rejected', reason: 'invalid_type', rel: r });
            continue;
          }
          const fromNorm = normalizeIdForEngine(r.from);
          const toNorm = normalizeIdForEngine(r.to);
          if (!validEntryIds.has(fromNorm) || !validEntryIds.has(toNorm)) {
            relClassification.push({ kind: 'dangling', rel: r });
            continue;
          }
          // Stash the normalized ids on the rel so the writer uses them
          relClassification.push({
            kind: 'clean',
            rel: { ...r, from: fromNorm, to: toNorm, _originalFrom: r.from, _originalTo: r.to },
          });
        }

        const plan = {
          vaultDir: resolved,
          projectId,
          healthScore: validation.healthScore,
          healthTier: validation.healthTier,
          categories: validation.categories,
          entriesFound: vault.entries.length,
          entriesClean: entryClassification.filter((c) => c.kind === 'clean').length,
          entriesRepaired: entryClassification.filter((c) => c.kind === 'repaired').length,
          entriesRejected: entryClassification.filter((c) => c.kind === 'rejected').length,
          relationshipsFound: vault.relationships.length,
          relationshipsClean: relClassification.filter((c) => c.kind === 'clean').length,
          relationshipsDangling: relClassification.filter((c) => c.kind === 'dangling').length,
          relationshipsRejected: relClassification.filter((c) => c.kind === 'rejected').length,
          dryRun: validateOnly,
          repairMode: repair,
        };

        if (opts.skipRelationships) {
          plan.relationshipsClean = 0;
          plan.relationshipsDangling = 0;
          plan.relationshipsRejected = 0;
        }

        // 5. Validate-only path: print plan + exit
        if (validateOnly) {
          plan.outcome = 'dry-run';
          if (opts.json) {
            console.log(JSON.stringify({
              plan,
              validation,
              entryClassification: entryClassification.map((c) => ({
                kind: c.kind,
                reason: c.reason,
                id: c.entry && c.entry.id,
                category: c.entry && c.entry._category,
                repairs: c.repairs,
              })),
              relClassification: relClassification.map((c) => ({
                kind: c.kind,
                reason: c.reason,
                from: c.rel && c.rel.from,
                to: c.rel && c.rel.to,
                type: c.rel && c.rel.type,
              })),
            }, null, 2));
          } else {
            printPlanHuman(plan, validation, entryClassification, relClassification);
            console.log('');
            console.log(chalk.gray('Re-run without --dry-run / --validate-only to commit.'));
          }
          return;
        }

        // 6. Actual import
        const cfg = cliConfig.read();
        const store = meridian.init(cliConfig.getDataDir(), { llm: cfg.llm });

        let projectExists = false;
        try {
          const projects = store.listProjects() || [];
          projectExists = projects.some((p) => (p.id || p.project || p) === projectId);
        } catch (_) { /* will create */ }
        if (!projectExists) {
          try {
            if (typeof store.createProject === 'function') {
              store.createProject({
                id: projectId,
                name: projectId,
                description: `Imported from Recall-Pattern vault at ${resolved}`,
              });
            } else if (typeof store.initProject === 'function') {
              store.initProject(projectId);
            }
          } catch (err) {
            console.warn(chalk.yellow(`(warn) couldn't auto-create project ${projectId}: ${err.message}; will attempt to add entries anyway`));
          }
        }

        const importedEntries = [];
        const importedRepaired = [];
        const skippedDuplicates = [];
        const failedDuringWrite = [];
        for (const c of entryClassification) {
          if (c.kind === 'rejected') continue;
          try {
            const fields = buildMifFields(c.entry, nowIso);
            store.addEntry(projectId, fields);
            if (c.kind === 'repaired') importedRepaired.push({ id: c.entry.id, repairs: c.repairs });
            else importedEntries.push(c.entry.id);
          } catch (err) {
            if (err && err.name === 'DuplicateEntryError') skippedDuplicates.push(c.entry.id);
            else failedDuringWrite.push({ id: c.entry.id, error: err.message });
          }
        }

        let importedRels = 0;
        const failedRels = [];
        if (!opts.skipRelationships) {
          for (const c of relClassification) {
            if (c.kind !== 'clean') continue;
            try {
              store.addRelationship(projectId, c.rel.from, projectId, c.rel.to, c.rel.type);
              importedRels++;
            } catch (err) {
              failedRels.push({
                from: c.rel.from, to: c.rel.to, type: c.rel.type, error: err.message,
              });
            }
          }
        }

        const report = {
          ...plan,
          outcome: 'imported',
          importedEntriesClean: importedEntries.length,
          importedEntriesRepaired: importedRepaired.length,
          skippedDuplicates: skippedDuplicates.length,
          failedDuringWrite: failedDuringWrite.length,
          importedRelationships: importedRels,
          failedRelationships: failedRels.length,
        };

        if (opts.json) {
          console.log(JSON.stringify({
            report,
            importedRepaired,
            failedDuringWrite,
            failedRels,
            rejectedEntries: entryClassification
              .filter((c) => c.kind === 'rejected')
              .map((c) => ({
                id: c.entry && c.entry.id,
                path: c.entry && c.entry._path,
                reason: c.reason,
                findings: c.findings,
              })),
            danglingRelationships: relClassification
              .filter((c) => c.kind === 'dangling')
              .map((c) => ({ from: c.rel.from, to: c.rel.to, type: c.rel.type })),
          }, null, 2));
        } else {
          printImportReportHuman(report, {
            importedRepaired,
            failedDuringWrite,
            failedRels,
            entryClassification,
            relClassification,
          }, projectId);
        }
      } catch (err) {
        console.error(chalk.red(`import-vault error: ${err.message}`));
        process.exitCode = 1;
      }
    });
};

// --------------------------------------------------------------------------
// Human-readable output
// --------------------------------------------------------------------------
function printPlanHuman(plan, validation, entryClassification, relClassification) {
  console.log('');
  console.log(chalk.cyan.bold(`Plan: recall import-vault${plan.repairMode ? ' --repair' : ''}`));
  console.log('');
  console.log(`Vault dir:               ${plan.vaultDir}`);
  console.log(`Inferred project:        ${plan.projectId}`);
  console.log(`Vault health:            ${plan.healthScore}/100 (${plan.healthTier})`);
  console.log('');
  console.log(`Entries found:           ${plan.entriesFound}`);
  console.log(`  Clean:                 ${chalk.green(plan.entriesClean)}`);
  if (plan.entriesRepaired > 0) console.log(`  Repaired:              ${chalk.yellow(plan.entriesRepaired)} (--repair applied auto-fixes)`);
  if (plan.entriesRejected > 0) console.log(`  Rejected:              ${chalk.red(plan.entriesRejected)} (errors not recoverable)`);
  console.log('');
  console.log(`Relationships found:     ${plan.relationshipsFound}`);
  console.log(`  Clean:                 ${chalk.green(plan.relationshipsClean)}`);
  if (plan.relationshipsDangling > 0) console.log(`  Dangling endpoints:    ${chalk.yellow(plan.relationshipsDangling)} (from/to id not in vault)`);
  if (plan.relationshipsRejected > 0) console.log(`  Rejected:              ${chalk.red(plan.relationshipsRejected)} (bad type / missing field / parse error)`);

  // Show a handful of rejected entries so the user sees what's wrong
  const rejected = entryClassification.filter((c) => c.kind === 'rejected');
  if (rejected.length > 0) {
    console.log('');
    console.log(chalk.red('First 5 rejected entries:'));
    for (const c of rejected.slice(0, 5)) {
      const id = (c.entry && c.entry.id) || (c.entry && c.entry._file) || '(unknown)';
      console.log(`  ${id}: ${c.reason}`);
      for (const f of (c.findings || []).slice(0, 3)) {
        console.log(`    - ${f.code}${f.detail ? ': ' + f.detail : ''}`);
      }
    }
  }
}

function printImportReportHuman(report, extras, projectId) {
  console.log('');
  console.log(chalk.green.bold('Import complete: ' + projectId));
  console.log('');
  console.log(`Vault health:            ${report.healthScore}/100 (${report.healthTier})`);
  console.log(`Entries imported clean:  ${chalk.green(report.importedEntriesClean)}`);
  if (report.importedEntriesRepaired > 0) {
    console.log(`Entries imported repaired: ${chalk.yellow(report.importedEntriesRepaired)}`);
  }
  if (report.skippedDuplicates > 0) {
    console.log(`Skipped duplicates:      ${chalk.gray(report.skippedDuplicates)} (already in KB; re-imports are idempotent)`);
  }
  if (report.entriesRejected > 0) {
    console.log(`Rejected (validation):   ${chalk.red(report.entriesRejected)} (errors not recoverable${report.repairMode ? '' : '; try --repair'})`);
  }
  if (report.failedDuringWrite > 0) {
    console.log(`Failed during write:     ${chalk.red(report.failedDuringWrite)} (engine-side validation rejected)`);
  }
  console.log(`Relationships imported:  ${chalk.green(report.importedRelationships)}`);
  if (report.relationshipsDangling > 0) {
    console.log(`Relationships dangling:  ${chalk.yellow(report.relationshipsDangling)} (endpoints not in vault; skipped)`);
  }
  if (report.failedRelationships > 0) {
    console.log(`Failed relationships:    ${chalk.red(report.failedRelationships)}`);
  }
  if (extras.importedRepaired.length > 0) {
    console.log('');
    console.log(chalk.yellow('Auto-repairs applied (first 5):'));
    for (const r of extras.importedRepaired.slice(0, 5)) {
      console.log(`  ${r.id}: ${r.repairs.join('; ')}`);
    }
  }
  if (extras.failedDuringWrite.length > 0) {
    console.log('');
    console.log(chalk.red('First 5 engine rejections:'));
    for (const f of extras.failedDuringWrite.slice(0, 5)) {
      console.log(`  ${f.id}: ${f.error}`);
    }
  }
  console.log('');
  console.log(chalk.gray(`Verify: recall query ${projectId} "TABLE name FROM decisions"`));
}
