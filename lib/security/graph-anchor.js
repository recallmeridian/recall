'use strict';

// Recall graph anchor — periodic signed root hash of the trusted KB
// + policy registry, with verify + diff against last known-good anchor.
//
// Addresses the recovery gap raised by Grok and sharpened by Codex in
// the 2026-05-12 OpenClaw security brainstorm: hash-chained ledgers
// give you tamper-evidence on the ledgers; they do NOT give you
// recovery from corruption of the KB itself. Anchors provide:
//   (a) a single "is the graph as expected?" check after restore /
//       suspected tampering / drift incidents,
//   (b) a known-good rollback point to rebuild against the
//       reconsolidation ledger,
//   (c) a public-auditable proof that a given graph existed at a
//       given timestamp (operators can publish anchor roots to a
//       third-party timestamp service or git tag).
//
// Anchors are SIGNED with the operator's HMAC key from
// ~/.recall/security/anchor-key (auto-generated on first run if
// absent). The key never enters the source tree or the ledger; only
// HMAC outputs do. An attacker who tampers with both the KB and the
// anchor ledger but lacks the key cannot forge a passing verification.
//
// Anchor scope:
//   • All KB entry IDs + content hashes, grouped by project + category
//   • All registered feature manifest IDs + manifest hashes
//   • All registered specialist IDs + version + prompt hashes
//   • Head hash of each tamper-evident ledger we care about
//     (egress-scan-ledger, approvals, runs, anchor-ledger itself
//     trivially excluded)
//
// The anchor root is the SHA256 of a canonical JSON of the above.
// Determinism: keys are sorted at every level; arrays are sorted by id.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function homeRecallDir() {
  return path.join(os.homedir(), '.recall');
}

function anchorKeyPath() {
  return path.join(homeRecallDir(), 'security', 'anchor-key');
}

function anchorLedgerPath(opts = {}) {
  return opts.ledgerPath || path.join(opts.dataDir || homeRecallDir(), 'security', 'graph-anchor-ledger.jsonl');
}

function ensureFileDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getOrCreateAnchorKey() {
  const p = anchorKeyPath();
  if (fs.existsSync(p)) return fs.readFileSync(p);
  ensureFileDir(p);
  const key = crypto.randomBytes(32);
  fs.writeFileSync(p, key);
  try { fs.chmodSync(p, 0o600); } catch (_) { /* best-effort on Windows */ }
  return key;
}

function canonicalJson(obj) {
  // Stable stringify: sort object keys at every level.
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Snapshot the trusted KB graph state.
//
// Caller supplies an `inputs` object describing the graph; we don't
// reach into the data store directly to keep this module pure-ish and
// testable. The CLI command wires it to the real store. Inputs:
//   {
//     entries:       [{ id, project, category, contentHash }],
//     manifests:     [{ feature_id, manifestHash }],
//     specialists:   [{ id, version, promptHash }],
//     ledgerHeads:   { ledgerName: 'sha256:abc...' | null },
//     extra:         { ...optional operator-defined fields }
//   }
function computeAnchorState(inputs = {}) {
  const entries = (inputs.entries || [])
    .map((e) => ({ id: String(e.id), project: e.project || null, category: e.category || null, contentHash: e.contentHash || null }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const manifests = (inputs.manifests || [])
    .map((m) => ({ feature_id: String(m.feature_id), manifestHash: m.manifestHash || null }))
    .sort((a, b) => a.feature_id.localeCompare(b.feature_id));

  const specialists = (inputs.specialists || [])
    .map((s) => ({ id: String(s.id), version: s.version != null ? Number(s.version) : null, promptHash: s.promptHash || null }))
    .sort((a, b) => a.id.localeCompare(b.id) || (a.version - b.version));

  const ledgerHeads = inputs.ledgerHeads || {};
  const sortedHeads = {};
  for (const k of Object.keys(ledgerHeads).sort()) sortedHeads[k] = ledgerHeads[k] || null;

  const state = {
    entries,
    manifests,
    specialists,
    ledgerHeads: sortedHeads,
    extra: inputs.extra || null,
    schemaVersion: 1,
  };
  const canonical = canonicalJson(state);
  const rootHash = 'sha256:' + sha256Hex(canonical);

  // Also compute per-category sub-roots so diffs can pinpoint which
  // surface drifted without rehashing everything.
  const subRoots = {
    entries: 'sha256:' + sha256Hex(canonicalJson(entries)),
    manifests: 'sha256:' + sha256Hex(canonicalJson(manifests)),
    specialists: 'sha256:' + sha256Hex(canonicalJson(specialists)),
    ledgerHeads: 'sha256:' + sha256Hex(canonicalJson(sortedHeads)),
  };

  return {
    rootHash,
    subRoots,
    counts: {
      entries: entries.length,
      manifests: manifests.length,
      specialists: specialists.length,
      ledgerHeads: Object.keys(sortedHeads).length,
    },
    schemaVersion: 1,
  };
}

function signAnchor(rootHash, opts = {}) {
  const key = opts.key || getOrCreateAnchorKey();
  return 'hmac-sha256:' + crypto.createHmac('sha256', key).update(rootHash).digest('hex');
}

function readAnchorLedger(opts = {}) {
  const p = anchorLedgerPath(opts);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  if (!raw.trim()) return [];
  return raw.trim().split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch (_) { return null; }
  }).filter(Boolean);
}

function entryHash(entry) {
  return 'sha256:' + sha256Hex(canonicalJson({
    sequence: entry.sequence,
    previousHash: entry.previousHash,
    anchorId: entry.anchorId,
    createdAt: entry.createdAt,
    rootHash: entry.rootHash,
    subRoots: entry.subRoots,
    counts: entry.counts,
    signature: entry.signature,
    schemaVersion: entry.schemaVersion,
    label: entry.label,
  }));
}

function createAnchor(inputs, opts = {}) {
  const ledgerFile = anchorLedgerPath(opts);
  ensureFileDir(ledgerFile);
  if (!fs.existsSync(ledgerFile)) fs.writeFileSync(ledgerFile, '', 'utf8');

  const existing = readAnchorLedger(opts);
  const previous = existing[existing.length - 1] || null;

  const state = computeAnchorState(inputs);
  const signature = signAnchor(state.rootHash, opts);
  const createdAt = opts.createdAt || new Date().toISOString();
  const anchorId = 'anchor-' + sha256Hex(state.rootHash + '|' + createdAt).slice(0, 16);

  const entry = {
    sequence: existing.length + 1,
    previousHash: previous ? previous.entryHash : null,
    anchorId,
    createdAt,
    rootHash: state.rootHash,
    subRoots: state.subRoots,
    counts: state.counts,
    signature,
    schemaVersion: state.schemaVersion,
    label: opts.label || null,
  };
  entry.entryHash = entryHash(entry);

  fs.appendFileSync(ledgerFile, JSON.stringify(entry) + '\n', 'utf8');

  // Compute drift summary vs previous anchor for the CLI to display.
  let driftSummary = null;
  if (previous) {
    driftSummary = {
      rootChanged: previous.rootHash !== entry.rootHash,
      subRootsChanged: Object.keys(state.subRoots).filter((k) => previous.subRoots && previous.subRoots[k] !== state.subRoots[k]),
      countDeltas: {
        entries: state.counts.entries - (previous.counts ? previous.counts.entries : 0),
        manifests: state.counts.manifests - (previous.counts ? previous.counts.manifests : 0),
        specialists: state.counts.specialists - (previous.counts ? previous.counts.specialists : 0),
        ledgerHeads: state.counts.ledgerHeads - (previous.counts ? previous.counts.ledgerHeads : 0),
      },
    };
  }

  return { entry, driftSummary, ledgerPath: ledgerFile };
}

function listAnchors(opts = {}) {
  const entries = readAnchorLedger(opts);
  const limit = opts.limit ? Number(opts.limit) : entries.length;
  return entries.slice(-limit);
}

function getAnchor(anchorId, opts = {}) {
  const entries = readAnchorLedger(opts);
  return entries.find((e) => e.anchorId === anchorId) || null;
}

function verifyLedgerChain(opts = {}) {
  const ledgerFile = anchorLedgerPath(opts);
  if (!fs.existsSync(ledgerFile)) return { ok: true, ledgerPath: ledgerFile, entries: 0, message: 'no_ledger_yet' };
  const entries = readAnchorLedger(opts);
  let prev = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.sequence !== i + 1) return { ok: false, failedAt: i + 1, reason: 'sequence_gap', ledgerPath: ledgerFile };
    if (e.previousHash !== (prev ? prev.entryHash : null)) return { ok: false, failedAt: i + 1, reason: 'previous_hash_mismatch', ledgerPath: ledgerFile };
    const recomputed = entryHash({ ...e });
    if (recomputed !== e.entryHash) return { ok: false, failedAt: i + 1, reason: 'entry_hash_mismatch', ledgerPath: ledgerFile };
    prev = e;
  }
  return { ok: true, ledgerPath: ledgerFile, entries: entries.length, headHash: prev ? prev.entryHash : null };
}

// Verify current graph state against a stored anchor. Optional key
// override (defaults to the operator's anchor-key on disk). Returns
// {ok, drift, anchor, currentState}.
function verifyAgainstAnchor(currentInputs, anchorIdOrEntry, opts = {}) {
  const anchor = typeof anchorIdOrEntry === 'string'
    ? getAnchor(anchorIdOrEntry, opts)
    : anchorIdOrEntry;
  if (!anchor) return { ok: false, reason: 'anchor_not_found', anchorId: anchorIdOrEntry };

  const state = computeAnchorState(currentInputs);
  const expectedSignature = signAnchor(anchor.rootHash, opts);
  const signatureValid = expectedSignature === anchor.signature;

  const ok = signatureValid && state.rootHash === anchor.rootHash;
  const drift = {
    rootChanged: state.rootHash !== anchor.rootHash,
    signatureValid,
    subRootsChanged: Object.keys(state.subRoots).filter((k) => anchor.subRoots && anchor.subRoots[k] !== state.subRoots[k]),
    countDeltas: {
      entries: state.counts.entries - (anchor.counts ? anchor.counts.entries : 0),
      manifests: state.counts.manifests - (anchor.counts ? anchor.counts.manifests : 0),
      specialists: state.counts.specialists - (anchor.counts ? anchor.counts.specialists : 0),
      ledgerHeads: state.counts.ledgerHeads - (anchor.counts ? anchor.counts.ledgerHeads : 0),
    },
  };

  return {
    ok,
    anchorId: anchor.anchorId,
    anchorRootHash: anchor.rootHash,
    currentRootHash: state.rootHash,
    signatureValid,
    drift,
    counts: { current: state.counts, anchor: anchor.counts },
  };
}

module.exports = {
  computeAnchorState,
  createAnchor,
  listAnchors,
  getAnchor,
  verifyLedgerChain,
  verifyAgainstAnchor,
  signAnchor,
  anchorLedgerPath,
  anchorKeyPath,
  getOrCreateAnchorKey,
};
