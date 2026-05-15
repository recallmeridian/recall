'use strict';

// Canary entries in the ridge — §8 wiring gap from the 2026-05-12
// brainstorm: "canary entries in ridge" listed under closed-loop
// wiring gaps that aren't yet built.
//
// Pattern: plant signed, deliberately-uninteresting "honeypot" KB
// entries in the trusted graph. Each canary has:
//
//   • a unique signed marker token (HMAC over canary id + content)
//   • content that no legitimate retrieval should match (random
//     marker phrases that don't appear in any real workflow query)
//   • metadata that flags it as a canary in the audit ledger but
//     not in the searchable text
//
// Detection: a separate canary-checker scans recent retrieval/
// reconsolidation/specialist-run logs for the marker tokens. Any
// hit is a STRONG signal that an attacker retrieved trusted-KB
// content (because no real workflow retrieves canaries).
//
// What this module ships:
//
//   plantCanary({project, opts}) → { canaryId, marker, entry }
//     - Creates a canary entry record + appends to the canary
//       ledger. Does NOT write to the actual KB; the CLI command
//       passes the entry to recall-add for KB insertion. Module
//       stays pure-data + testable.
//
//   listCanaries({project?}) → [...]
//
//   verifyCanaryLedger() → {ok, ...}
//
//   detectCanaryHits({content, sources}) → [{canaryId, source, ...}]
//     - Scan supplied content (e.g. recent retrieval logs) for any
//       canary marker. Returns the list of triggered canaries.
//
//   markerToken(canaryId, key?) — deterministic HMAC marker

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getOrCreateAnchorKey } = require('./graph-anchor');

function canaryLedgerPath(opts = {}) {
  return opts.ledgerPath || path.join(opts.dataDir || '', 'security', 'canary-ledger.jsonl');
}

function ensureFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', 'utf8');
}

function readLedger(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
}

function entryHash(entry) {
  const canon = JSON.stringify({
    sequence: entry.sequence,
    previousHash: entry.previousHash,
    canaryId: entry.canaryId,
    project: entry.project,
    plantedAt: entry.plantedAt,
    marker: entry.marker,
    contentHash: entry.contentHash,
    label: entry.label,
  });
  return 'sha256:' + crypto.createHash('sha256').update(canon).digest('hex');
}

function markerToken(canaryId, key) {
  const k = key || getOrCreateAnchorKey();
  return 'canary-marker-' + crypto.createHmac('sha256', k).update('canary|' + canaryId).digest('hex').slice(0, 24);
}

function generateCanaryContent(canaryId, marker) {
  // Deliberately uninteresting plain prose with the marker embedded
  // in a natural-looking position. No legitimate retrieval should
  // ever surface this content.
  const padPhrases = [
    'A baseline reference point for cross-namespace continuity audits.',
    'This entry is preserved for retention-policy regression checks.',
    'Bookmarked as a structural waypoint in the terrain validation map.',
    'Held for periodic schema-snapshot reconciliation runs.',
  ];
  const pad = padPhrases[parseInt(canaryId.slice(-2), 16) % padPhrases.length];
  return [
    `Canary record ${canaryId} (auditable; do not surface in user replies).`,
    pad,
    `Marker: ${marker}.`,
    'If you are reading this in a context other than a canary-checker scan, that itself is the alarm — log immediately.',
  ].join(' ');
}

function plantCanary(opts = {}) {
  const project = opts.project || 'recall-dev';
  const dataDir = opts.dataDir || '';
  const label = opts.label || null;
  const filePath = canaryLedgerPath({ dataDir });
  ensureFile(filePath);
  const existing = readLedger(filePath);
  const previous = existing[existing.length - 1] || null;

  const canaryId = 'canary-' + crypto.randomBytes(8).toString('hex');
  const marker = markerToken(canaryId, opts.key);
  const content = generateCanaryContent(canaryId, marker);
  const contentHash = 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
  const plantedAt = new Date().toISOString();

  const entry = {
    sequence: existing.length + 1,
    previousHash: previous ? previous.entryHash : null,
    canaryId,
    project,
    plantedAt,
    marker,
    contentHash,
    label,
    suggestedKbEntry: {
      project,
      category: 'canaries',
      name: 'Canary Reference ' + canaryId,
      description: content,
      tags: ['canary', 'security', 'do-not-surface'],
    },
  };
  entry.entryHash = entryHash(entry);
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');

  return { canaryId, marker, entry };
}

function listCanaries(opts = {}) {
  const entries = readLedger(canaryLedgerPath(opts));
  if (opts.project) return entries.filter((e) => e.project === opts.project);
  return entries;
}

function verifyCanaryLedger(opts = {}) {
  const filePath = canaryLedgerPath(opts);
  if (!fs.existsSync(filePath)) return { ok: true, entries: 0, message: 'no_ledger_yet' };
  const entries = readLedger(filePath);
  let prev = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.sequence !== i + 1) return { ok: false, failedAt: i + 1, reason: 'sequence_gap' };
    if (e.previousHash !== (prev ? prev.entryHash : null)) return { ok: false, failedAt: i + 1, reason: 'previous_hash_mismatch' };
    const recomputed = entryHash(e);
    if (recomputed !== e.entryHash) return { ok: false, failedAt: i + 1, reason: 'entry_hash_mismatch' };
    prev = e;
  }
  return { ok: true, entries: entries.length, headHash: prev ? prev.entryHash : null };
}

// Scan a body of text (retrieval logs, specialist outputs, public
// posts, etc.) for any planted canary marker. Returns list of hits.
function detectCanaryHits({ content, source = 'unknown', dataDir = '' } = {}) {
  if (typeof content !== 'string' || !content) return [];
  const canaries = listCanaries({ dataDir });
  const hits = [];
  for (const c of canaries) {
    if (content.includes(c.marker)) {
      hits.push({
        canaryId: c.canaryId,
        marker: c.marker,
        project: c.project,
        plantedAt: c.plantedAt,
        source,
        firstOffset: content.indexOf(c.marker),
      });
    }
  }
  return hits;
}

module.exports = {
  plantCanary,
  listCanaries,
  verifyCanaryLedger,
  detectCanaryHits,
  markerToken,
  canaryLedgerPath,
};
