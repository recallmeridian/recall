'use strict';

// Nightly Dream Cycle — Slice #4 of Codex's 5-slice OpenClaw security
// build order. Operationalizes the McClelland-McNaughton-O'Reilly 1995
// complementary-learning-systems pattern (KB entry
// mcclelland-mcnaughton-oreilly-1995-complementary-learning-systems):
//
//   Hippocampus = reconsolidation ledger + recent basin entries
//                 (fast, lossy, single-shot capture during waking)
//   Neocortex   = ridge terrain + validated KB
//                 (slow, integrated, sleep-replay consolidation)
//   Dream run   = nightly batch that walks the reconsolidation ledger,
//                 runs morphology diffs, detects sub-threshold drift,
//                 proposes terrain cleanups, integrates accepted
//                 episodes into ridge.
//
// Codex's hard rule, encoded here as a kernel invariant:
//   Never auto-promote live-write defenses.
// The dream cycle PROPOSES, it never ACTS. Output is a candidate
// list for human review, with the promotion gate (lib/security/
// promotion-gate.js) evaluating each proposal.
//
// What one dream run produces:
//   {
//     runId, startedAt, finishedAt, durationMs,
//     window: { hours, project },
//     surveys: {
//       reconsolidationEvents: { count, latest },
//       basinEntries:          { count, samples },
//       morphologyDelta:       { ... if available ... },
//       graphAnchorDrift:      { ... if anchor present ... },
//       deniedActions:         { count } from egress-scan ledger,
//       hardCases:             { count } from intelligence-failure-mine,
//     },
//     proposals: [
//       {
//         kind: 'terrain-cleanup' | 'promote-candidate' | 'retire-stale' |
//               'tighten-policy' | 'investigate-anomaly',
//         summary,
//         evidenceRefs: [...],
//         requiresHumanReview: true|false,
//         suggestedDecision: 'review' | 'block' | 'allow',
//       }
//     ],
//     anchorBefore?, anchorAfter?,    // if --create-anchors
//     ledgerEntry,                     // hash-chained run record
//   }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function dreamLedgerPath(opts = {}) {
  return opts.ledgerPath || path.join(opts.dataDir || '', 'security', 'dream-cycle-ledger.jsonl');
}

function ensureLedgerFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', 'utf8');
}

function readLedger(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch (_) { return null; }
  }).filter(Boolean);
}

function entryHash(entry) {
  const canon = JSON.stringify({
    sequence: entry.sequence,
    previousHash: entry.previousHash,
    runId: entry.runId,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    project: entry.project,
    windowHours: entry.windowHours,
    surveysSummary: entry.surveysSummary,
    proposalKinds: entry.proposalKinds,
    proposalCount: entry.proposalCount,
    anchorBeforeId: entry.anchorBeforeId,
    anchorAfterId: entry.anchorAfterId,
  });
  return 'sha256:' + crypto.createHash('sha256').update(canon).digest('hex');
}

// Each "surveyor" is a function (collectors) -> { count, ...meta }.
// Collectors are passed in so this module stays testable without
// touching the live KB. The CLI command wires real collectors.
function runDreamCycle(collectors, opts = {}) {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const project = opts.project || 'recall-dev';
  const windowHours = Number(opts.windowHours || 24);

  const safe = (label, fn) => {
    try { return fn(); }
    catch (err) { return { error: err.message, label }; }
  };

  const surveys = {
    reconsolidationEvents: safe('reconsolidationEvents', () => collectors.reconsolidationEvents
      ? collectors.reconsolidationEvents({ project, windowHours })
      : { count: 0, skipped: 'no-collector' }),
    basinEntries: safe('basinEntries', () => collectors.basinEntries
      ? collectors.basinEntries({ project, windowHours })
      : { count: 0, skipped: 'no-collector' }),
    morphologyDelta: safe('morphologyDelta', () => collectors.morphologyDelta
      ? collectors.morphologyDelta({ project, windowHours })
      : { skipped: 'no-collector' }),
    graphAnchorDrift: safe('graphAnchorDrift', () => collectors.graphAnchorDrift
      ? collectors.graphAnchorDrift({ project })
      : { skipped: 'no-collector' }),
    deniedActions: safe('deniedActions', () => collectors.deniedActions
      ? collectors.deniedActions({ windowHours })
      : { count: 0, skipped: 'no-collector' }),
    hardCases: safe('hardCases', () => collectors.hardCases
      ? collectors.hardCases({ project, windowHours })
      : { count: 0, skipped: 'no-collector' }),
  };

  // Synthesize proposals deterministically from survey contents.
  // The dream cycle PROPOSES; the promotion gate + human DECIDES.
  const proposals = [];

  // Reconsolidation activity → terrain cleanup candidate
  if (surveys.reconsolidationEvents.count >= 5) {
    proposals.push({
      kind: 'terrain-cleanup',
      summary: `${surveys.reconsolidationEvents.count} reconsolidation events in last ${windowHours}h — review for terrain anchor/relationship suggestions`,
      requiresHumanReview: true,
      suggestedDecision: 'review',
      evidenceRefs: [],
    });
  }

  // Basin growth → integrate or retire candidate
  if (surveys.basinEntries.count >= 3) {
    proposals.push({
      kind: 'promote-candidate',
      summary: `${surveys.basinEntries.count} basin entries pending classification — run promotion-check against holdout benchmark`,
      requiresHumanReview: true,
      suggestedDecision: 'review',
      evidenceRefs: surveys.basinEntries.samples || [],
    });
  }

  // Graph anchor drift → investigate
  if (surveys.graphAnchorDrift && surveys.graphAnchorDrift.rootChanged) {
    proposals.push({
      kind: 'investigate-anomaly',
      summary: 'Graph anchor drift detected — surfaces changed: ' + (surveys.graphAnchorDrift.subRootsChanged || []).join(', '),
      requiresHumanReview: true,
      suggestedDecision: 'review',
      evidenceRefs: surveys.graphAnchorDrift.anchorId ? [surveys.graphAnchorDrift.anchorId] : [],
    });
  }

  // Denied egress → may need policy tightening
  if (surveys.deniedActions.count >= 3) {
    proposals.push({
      kind: 'tighten-policy',
      summary: `${surveys.deniedActions.count} egress scans flagged in last ${windowHours}h — consider tightening detector or scanner-config`,
      requiresHumanReview: true,
      suggestedDecision: 'review',
      evidenceRefs: [],
    });
  }

  // Hard cases → curriculum proposals
  if (surveys.hardCases.count >= 5) {
    proposals.push({
      kind: 'promote-candidate',
      summary: `${surveys.hardCases.count} hard-case lessons mined — review for promotion to KB`,
      requiresHumanReview: true,
      suggestedDecision: 'review',
      evidenceRefs: [],
    });
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startedAtMs;
  const runId = 'dream-' + crypto.createHash('sha256')
    .update(startedAt + '|' + project + '|' + windowHours)
    .digest('hex').slice(0, 16);

  // Append to hash-chained dream cycle ledger.
  let ledgerEntry = null;
  if (opts.appendToLedger !== false && opts.dataDir) {
    const filePath = dreamLedgerPath(opts);
    ensureLedgerFile(filePath);
    const existing = readLedger(filePath);
    const previous = existing[existing.length - 1] || null;
    const surveysSummary = {
      reconsolidationEvents: surveys.reconsolidationEvents.count || 0,
      basinEntries: surveys.basinEntries.count || 0,
      deniedActions: surveys.deniedActions.count || 0,
      hardCases: surveys.hardCases.count || 0,
      anchorDrift: Boolean(surveys.graphAnchorDrift && surveys.graphAnchorDrift.rootChanged),
    };
    const e = {
      sequence: existing.length + 1,
      previousHash: previous ? previous.entryHash : null,
      runId,
      startedAt,
      finishedAt,
      project,
      windowHours,
      surveysSummary,
      proposalKinds: proposals.map((p) => p.kind),
      proposalCount: proposals.length,
      anchorBeforeId: opts.anchorBeforeId || null,
      anchorAfterId: opts.anchorAfterId || null,
    };
    e.entryHash = entryHash(e);
    fs.appendFileSync(filePath, JSON.stringify(e) + '\n', 'utf8');
    ledgerEntry = e;
  }

  return {
    runId,
    project,
    startedAt,
    finishedAt,
    durationMs,
    windowHours,
    surveys,
    proposals,
    ledgerEntry,
  };
}

function listDreamRuns(opts = {}) {
  return readLedger(dreamLedgerPath(opts));
}

function verifyDreamLedger(opts = {}) {
  const filePath = dreamLedgerPath(opts);
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

module.exports = {
  runDreamCycle,
  listDreamRuns,
  verifyDreamLedger,
  dreamLedgerPath,
};
