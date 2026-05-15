'use strict';

// Operator security health rollup (red/amber/green).
//
// Sister to lib/security/dashboard.js — but where dashboard is a
// detailed rollup, health is a 5-line traffic-light view. Each
// axis returns:
//
//   { status: 'green' | 'yellow' | 'red' | 'gray',
//     value: '<short string>',
//     reason: '<one-line reason>',
//     trend: '↑' | '↓' | '→' | null }   // null = no prior to compare
//
// Trend uses the most recent health-history ledger entry as the
// baseline (if any). The ledger is append-only hash-chained like
// every other ledger in the stack.
//
// Axes (7):
//   1. egress      — scan activity in last 24h
//   2. anchor      — KB hash matches latest anchor
//   3. canary      — planted; no recent hits
//   4. dream       — last dream-run within window
//   5. adversary   — last adversary run caught >= 90%
//   6. decay       — archive-candidate fraction below threshold
//   7. il-cycle    — last cycle verdict
//
// API:
//   computeHealth({ dataDir, project, windowHours, store, decayWarnFrac })
//     → { generatedAt, project, overallStatus, axes: [{name, ...}], issues: [...] }
//   appendHealthLedger(health, opts)
//   listHealthRuns(opts)
//   verifyHealthLedger(opts)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HEALTH_LEDGER = 'health-history-ledger.jsonl';

function healthLedgerPath(opts = {}) {
  return opts.ledgerPath || path.join(opts.dataDir || '', 'security', HEALTH_LEDGER);
}

function ensureFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', 'utf8');
}

function readJsonlTail(filePath, max = 500) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean).slice(-max);
}

function _within(ts, ageMs) {
  const t = Date.parse(ts || '');
  return Number.isFinite(t) && t >= Date.now() - ageMs;
}

function _entriesInLastHours(entries, hours, tsField) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return entries.filter((e) => {
    const t = Date.parse(e[tsField] || '');
    return Number.isFinite(t) && t >= cutoff;
  });
}

function _statusToRank(s) {
  return { red: 3, yellow: 2, gray: 1, green: 0 }[s] || 0;
}

function _rankToStatus(r) {
  return ['green', 'gray', 'yellow', 'red'][r] || 'gray';
}

// --- Axis evaluators ---------------------------------------------------

function _axisEgress(entries, windowHours) {
  if (!entries) return { name: 'egress', status: 'gray', value: 'no-ledger', reason: 'egress-scan-ledger not initialized' };
  const recent = _entriesInLastHours(entries, windowHours, 'scannedAt');
  const blocks = recent.filter((e) => e.decision === 'block').length;
  if (blocks > 0) return { name: 'egress', status: 'red', value: `${blocks} blocks/${recent.length}`, reason: `${blocks} block-level egress finding(s) in last ${windowHours}h` };
  const reviews = recent.filter((e) => e.decision === 'review').length;
  if (recent.length === 0) return { name: 'egress', status: 'gray', value: '0/?', reason: 'no scans in window — DLP may not be invoked' };
  if (reviews > recent.length * 0.5) return { name: 'egress', status: 'yellow', value: `${reviews} reviews/${recent.length}`, reason: 'review-level findings exceed 50% — consider tightening or auditing' };
  return { name: 'egress', status: 'green', value: `${recent.length} scans, 0 blocks`, reason: 'all egress passed or surfaced for review only' };
}

function _axisAnchor(anchorEntries, store, dataDir) {
  if (!anchorEntries || anchorEntries.length === 0) return { name: 'anchor', status: 'red', value: 'none', reason: 'no graph anchor exists' };
  // Try to verify the latest anchor against current state.
  try {
    const { verifyAgainstAnchor } = require('./graph-anchor');
    const { buildSnapshotInputs } = require('./graph-snapshot');
    const latest = anchorEntries[anchorEntries.length - 1];
    if (!store) return { name: 'anchor', status: 'gray', value: latest.anchorId.slice(0, 16), reason: 'no store provided; cannot verify against current' };
    const inputs = buildSnapshotInputs(store, { dataDir });
    const result = verifyAgainstAnchor(inputs, latest, { dataDir });
    if (result.ok) return { name: 'anchor', status: 'green', value: `${anchorEntries.length} anchors; verified`, reason: 'current state matches latest anchor' };
    return { name: 'anchor', status: 'yellow', value: 'drift', reason: `current root differs from anchor ${result.anchorId}; surfaces: ${result.drift.subRootsChanged.join(', ')}` };
  } catch (err) {
    return { name: 'anchor', status: 'gray', value: 'verify-failed', reason: 'verify errored: ' + err.message };
  }
}

function _axisCanary(canaryEntries) {
  if (!canaryEntries || canaryEntries.length === 0) return { name: 'canary', status: 'yellow', value: '0', reason: 'no canaries planted; cannot detect retrieval-based exfil' };
  // We don't run canary-check from health (would require scanning egress
  // content). Just report the planted count.
  return { name: 'canary', status: 'green', value: String(canaryEntries.length), reason: `${canaryEntries.length} canaries planted; run canary-check against outbound surfaces to detect hits` };
}

function _axisDream(dreamEntries, windowHours) {
  if (!dreamEntries || dreamEntries.length === 0) return { name: 'dream', status: 'yellow', value: 'none', reason: 'no dream-cycle run on record; should run nightly' };
  const last = dreamEntries[dreamEntries.length - 1];
  const tolerance = (windowHours + 12) * 60 * 60 * 1000;
  if (!_within(last.startedAt, tolerance)) return { name: 'dream', status: 'red', value: 'stale', reason: `last dream-cycle ${last.startedAt} is older than ${windowHours + 12}h — scheduled task may be broken` };
  return { name: 'dream', status: 'green', value: `${dreamEntries.length} runs; last ${last.startedAt}`, reason: 'dream-cycle running on schedule' };
}

function _axisAdversary(advEntries) {
  if (!advEntries || advEntries.length === 0) return { name: 'adversary', status: 'yellow', value: 'none', reason: 'no adversary run on record' };
  const last = advEntries[advEntries.length - 1];
  const rate = last.summary && last.summary.catchRateAny;
  if (rate == null) return { name: 'adversary', status: 'gray', value: 'unmeasured', reason: 'last adversary run lacks catchRateAny' };
  if (rate >= 0.9) return { name: 'adversary', status: 'green', value: `${(rate * 100).toFixed(0)}% catch`, reason: `last run caught ${(rate * 100).toFixed(0)}%; defenses holding` };
  if (rate >= 0.6) return { name: 'adversary', status: 'yellow', value: `${(rate * 100).toFixed(0)}% catch`, reason: `last run caught only ${(rate * 100).toFixed(0)}%; defense gap present` };
  return { name: 'adversary', status: 'red', value: `${(rate * 100).toFixed(0)}% catch`, reason: `last run caught only ${(rate * 100).toFixed(0)}%; significant defense gap` };
}

function _axisDecay(store, project, decayWarnFrac = 0.10) {
  if (!store) return { name: 'decay', status: 'gray', value: 'no-store', reason: 'no store provided' };
  try {
    const { evaluateCorpus } = require('./decay-policy');
    const entries = (store.listEntries(project) || []).map((e) => ({ id: e.id, project, category: e.category, createdAt: e.createdAt, confidence: e.confidence }));
    if (entries.length === 0) return { name: 'decay', status: 'gray', value: '0 entries', reason: `${project} has no entries to evaluate` };
    const r = evaluateCorpus(entries);
    const archiveFrac = r.archiveCandidates.length / Math.max(1, r.total);
    if (archiveFrac === 0) return { name: 'decay', status: 'green', value: `0/${r.total}`, reason: 'no archive candidates' };
    if (archiveFrac < decayWarnFrac) return { name: 'decay', status: 'green', value: `${r.archiveCandidates.length}/${r.total}`, reason: `${(archiveFrac * 100).toFixed(1)}% archive candidates — below warn threshold` };
    if (archiveFrac < decayWarnFrac * 3) return { name: 'decay', status: 'yellow', value: `${r.archiveCandidates.length}/${r.total}`, reason: `${(archiveFrac * 100).toFixed(1)}% archive candidates — consider running knowledge-transition` };
    return { name: 'decay', status: 'red', value: `${r.archiveCandidates.length}/${r.total}`, reason: `${(archiveFrac * 100).toFixed(1)}% archive candidates — KB needs hygiene pass` };
  } catch (err) {
    return { name: 'decay', status: 'gray', value: 'err', reason: 'decay-evaluate errored: ' + err.message };
  }
}

function _axisIlCycle(cycleEntries) {
  if (!cycleEntries || cycleEntries.length === 0) return { name: 'il-cycle', status: 'gray', value: 'none', reason: 'no IL cycle on record' };
  const last = cycleEntries[cycleEntries.length - 1];
  const verdict = last.verdictDecision || last.gateDecision;
  if (verdict === 'promote') return { name: 'il-cycle', status: 'green', value: 'promote', reason: `last cycle ${last.cycleId} verdict=promote` };
  if (verdict === 'hold' || verdict === 'hold-low-consensus' || verdict === 'requires_approval') return { name: 'il-cycle', status: 'yellow', value: verdict, reason: `last cycle ${last.cycleId} verdict=${verdict}; awaiting evidence or approval` };
  if (verdict === 'revert' || verdict === 'block') return { name: 'il-cycle', status: 'red', value: verdict, reason: `last cycle ${last.cycleId} verdict=${verdict}; bad patch rejected` };
  return { name: 'il-cycle', status: 'gray', value: verdict || 'unknown', reason: `last cycle verdict='${verdict}'; unfamiliar verdict` };
}

// --- Main entry point --------------------------------------------------

function computeHealth({ dataDir, project = 'recall-dev', windowHours = 24, store = null, decayWarnFrac = 0.10 } = {}) {
  const generatedAt = new Date().toISOString();

  // Read every ledger we care about (best-effort).
  const egressEntries = readJsonlTail(path.join(dataDir || '', 'security', 'egress-scan-ledger.jsonl'));
  const anchorEntries = readJsonlTail(path.join(dataDir || '', 'security', 'graph-anchor-ledger.jsonl'));
  const canaryEntries = readJsonlTail(path.join(dataDir || '', 'security', 'canary-ledger.jsonl'));
  const dreamEntries = readJsonlTail(path.join(dataDir || '', 'security', 'dream-cycle-ledger.jsonl'));
  const advEntries = readJsonlTail(path.join(dataDir || '', 'security', 'adversary-run-ledger.jsonl'));
  const cycleEntries = readJsonlTail(path.join(dataDir || '', 'intelligence', 'cycle-runner-ledger.jsonl'));

  const axes = [
    _axisEgress(egressEntries, windowHours),
    _axisAnchor(anchorEntries, store, dataDir),
    _axisCanary(canaryEntries),
    _axisDream(dreamEntries, windowHours),
    _axisAdversary(advEntries),
    _axisDecay(store, project, decayWarnFrac),
    _axisIlCycle(cycleEntries),
  ];

  // Trend comparison against previous health run.
  const priorRuns = readJsonlTail(healthLedgerPath({ dataDir }));
  const priorByAxis = {};
  if (priorRuns.length > 0) {
    const prior = priorRuns[priorRuns.length - 1];
    for (const a of (prior.axes || [])) priorByAxis[a.name] = a.status;
  }
  for (const a of axes) {
    const prior = priorByAxis[a.name];
    if (prior == null) { a.trend = null; }
    else if (_statusToRank(a.status) < _statusToRank(prior)) a.trend = '↑'; // less-bad = better
    else if (_statusToRank(a.status) > _statusToRank(prior)) a.trend = '↓';
    else a.trend = '→';
  }

  const worst = axes.reduce((acc, a) => Math.max(acc, _statusToRank(a.status)), 0);
  const overallStatus = _rankToStatus(worst);

  const issues = axes.filter((a) => a.status === 'red' || a.status === 'yellow').map((a) => `${a.name}: ${a.reason}`);

  return { generatedAt, project, windowHours, overallStatus, axes, issues };
}

function _entryHash(entry) {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify({
    sequence: entry.sequence,
    previousHash: entry.previousHash,
    generatedAt: entry.generatedAt,
    project: entry.project,
    overallStatus: entry.overallStatus,
    axes: entry.axes,
  })).digest('hex');
}

function appendHealthLedger(health, opts = {}) {
  const filePath = healthLedgerPath(opts);
  ensureFile(filePath);
  const existing = readJsonlTail(filePath, 2000);
  const previous = existing[existing.length - 1] || null;
  const entry = {
    sequence: existing.length + 1,
    previousHash: previous ? previous.entryHash : null,
    generatedAt: health.generatedAt,
    project: health.project,
    overallStatus: health.overallStatus,
    axes: (health.axes || []).map((a) => ({ name: a.name, status: a.status, value: a.value, trend: a.trend })),
  };
  entry.entryHash = _entryHash(entry);
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function listHealthRuns(opts = {}) {
  return readJsonlTail(healthLedgerPath(opts));
}

function verifyHealthLedger(opts = {}) {
  const filePath = healthLedgerPath(opts);
  if (!fs.existsSync(filePath)) return { ok: true, entries: 0, message: 'no_ledger_yet' };
  const entries = readJsonlTail(filePath, 10000);
  let prev = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.sequence !== i + 1) return { ok: false, failedAt: i + 1, reason: 'sequence_gap' };
    if (e.previousHash !== (prev ? prev.entryHash : null)) return { ok: false, failedAt: i + 1, reason: 'previous_hash_mismatch' };
    if (_entryHash(e) !== e.entryHash) return { ok: false, failedAt: i + 1, reason: 'entry_hash_mismatch' };
    prev = e;
  }
  return { ok: true, entries: entries.length, headHash: prev ? prev.entryHash : null };
}

module.exports = {
  computeHealth,
  appendHealthLedger,
  listHealthRuns,
  verifyHealthLedger,
};
