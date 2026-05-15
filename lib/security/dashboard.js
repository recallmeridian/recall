'use strict';

// Operator personal dashboard — Grok's open gap from §14 of the
// 2026-05-12 brainstorm. feature-ecosystem-health is a system-level
// diagnostic; this is the operator-facing summary of the whole
// security stack at a glance.
//
// Pulls from:
//   • egress-scan ledger (last 24h block/review/allow + detector mix)
//   • graph-anchor ledger (latest anchor + drift vs current)
//   • canary ledger (planted count + any recent hits)
//   • dream-cycle ledger (last run + open proposals)
//   • drift-detector summary (defense-efficacy vs baseline)
//   • decay policy (archive-candidate count across recall-dev)
//
// Output is a single read-only summary object the CLI renders
// human-readable + a JSON form for automation. Pure-data shape so
// it's testable without disk.

const fs = require('fs');
const path = require('path');

function readJsonlTail(filePath, max = 1000) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean).slice(-max);
}

function entriesInLastHours(entries, hours, tsField) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return entries.filter((e) => {
    const t = Date.parse(e[tsField] || 0);
    return Number.isFinite(t) && t >= cutoff;
  });
}

function buildDashboard({ dataDir, project = 'recall-dev', windowHours = 24, deps = {} } = {}) {
  // Each section is best-effort: if its source is missing/unreadable,
  // it returns a degraded summary so the dashboard still renders.

  const egressLedgerPath = path.join(dataDir, 'security', 'egress-scan-ledger.jsonl');
  const anchorLedgerPath = path.join(dataDir, 'security', 'graph-anchor-ledger.jsonl');
  const canaryLedgerPath = path.join(dataDir, 'security', 'canary-ledger.jsonl');
  const dreamLedgerPath = path.join(dataDir, 'security', 'dream-cycle-ledger.jsonl');
  const auditIngestLedgerPath = path.join(dataDir, 'security', 'audit-ingest-ledger.jsonl');
  const adversaryRunLedgerPath = path.join(dataDir, 'security', 'adversary-run-ledger.jsonl');
  const negPromLedgerPath = path.join(dataDir, 'security', 'negative-promotion-ledger.jsonl');
  const archReviewLedgerPath = path.join(dataDir, 'security', 'architect-review-ledger.jsonl');

  // --- Egress section -------------------------------------------------
  const egressEntries = readJsonlTail(egressLedgerPath);
  const recentScans = entriesInLastHours(egressEntries, windowHours, 'scannedAt');
  const blockN = recentScans.filter((e) => e.decision === 'block').length;
  const reviewN = recentScans.filter((e) => e.decision === 'review').length;
  const allowN = recentScans.filter((e) => e.decision === 'allow').length;
  const detectorMix = {};
  for (const e of recentScans) {
    for (const id of (e.blockerIds || [])) detectorMix[id] = (detectorMix[id] || 0) + 1;
    for (const id of (e.warningIds || [])) detectorMix[id] = (detectorMix[id] || 0) + 1;
  }
  const topDetectors = Object.entries(detectorMix).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const egress = {
    available: fs.existsSync(egressLedgerPath),
    totalEverScanned: egressEntries.length,
    last: { windowHours, scans: recentScans.length, block: blockN, review: reviewN, allow: allowN },
    topDetectors: topDetectors.map(([id, count]) => ({ detectorId: id, count })),
  };

  // --- Anchor section -------------------------------------------------
  const anchorEntries = readJsonlTail(anchorLedgerPath);
  const latestAnchor = anchorEntries[anchorEntries.length - 1] || null;
  const anchor = {
    available: fs.existsSync(anchorLedgerPath),
    totalAnchors: anchorEntries.length,
    latest: latestAnchor ? {
      anchorId: latestAnchor.anchorId,
      sequence: latestAnchor.sequence,
      createdAt: latestAnchor.createdAt,
      label: latestAnchor.label || null,
      counts: latestAnchor.counts,
    } : null,
  };

  // --- Canary section -------------------------------------------------
  const canaryEntries = readJsonlTail(canaryLedgerPath);
  const canaries = {
    available: fs.existsSync(canaryLedgerPath),
    totalPlanted: canaryEntries.length,
    plantedByProject: canaryEntries.reduce((acc, c) => { acc[c.project] = (acc[c.project] || 0) + 1; return acc; }, {}),
    // detectCanaryHits requires a content scan; dashboard can't run a
    // full scan — operator runs canary-check separately. We surface
    // the planted count + a reminder.
    note: 'run `recall security canary-check` against any outbound surface to detect retrieval hits',
  };

  // --- Dream cycle section --------------------------------------------
  const dreamEntries = readJsonlTail(dreamLedgerPath);
  const lastDream = dreamEntries[dreamEntries.length - 1] || null;
  const dream = {
    available: fs.existsSync(dreamLedgerPath),
    totalRuns: dreamEntries.length,
    last: lastDream ? {
      runId: lastDream.runId,
      sequence: lastDream.sequence,
      startedAt: lastDream.startedAt,
      project: lastDream.project,
      proposalCount: lastDream.proposalCount,
      proposalKinds: lastDream.proposalKinds,
      surveysSummary: lastDream.surveysSummary,
    } : null,
  };

  // --- Drift section --------------------------------------------------
  // Compute drift current-window (24h) vs baseline-window (last 7d minus current).
  let drift = { available: egress.available, decision: 'no-data' };
  if (egressEntries.length > 0) {
    try {
      const { evaluateDrift, summarizeLedger } = deps.driftDetector || require('./drift-detector');
      const baselineEntries = entriesInLastHours(egressEntries, 7 * 24, 'scannedAt')
        .filter((e) => Date.parse(e.scannedAt) < Date.now() - windowHours * 60 * 60 * 1000);
      const baseline = summarizeLedger(baselineEntries, (7 * 24) - windowHours);
      const current = summarizeLedger(recentScans, windowHours);
      const result = evaluateDrift({ baseline, current });
      drift = {
        available: true,
        decision: result.decision,
        driftCount: result.summary.driftCount,
        criticalCount: result.summary.criticalCount,
        topDrift: result.drifts[0] ? { axis: result.drifts[0].axis, severity: result.drifts[0].severity, detail: result.drifts[0].detail } : null,
      };
    } catch (err) {
      drift = { available: false, error: err.message };
    }
  }

  // --- Audit-Ingest section (Codex 5-slice #3 receiver) ---------------
  const auditEntries = readJsonlTail(auditIngestLedgerPath);
  const auditByStatus = { untrusted: 0, trusted: 0, rejected: 0 };
  // Reconstruct current status per recordId by walking the chain.
  const recordCurrentStatus = new Map();
  for (const e of auditEntries) {
    if (e.recordId && e.statusAfter) recordCurrentStatus.set(e.recordId, e.statusAfter);
  }
  for (const status of recordCurrentStatus.values()) {
    if (auditByStatus[status] != null) auditByStatus[status]++;
  }
  const auditAgents = new Set(auditEntries.map((e) => e.agentId).filter(Boolean));
  const auditIngest = {
    available: fs.existsSync(auditIngestLedgerPath),
    totalRecords: recordCurrentStatus.size,
    byStatus: auditByStatus,
    distinctAgents: auditAgents.size,
  };

  // --- Adversary-Run section ------------------------------------------
  const advEntries = readJsonlTail(adversaryRunLedgerPath);
  const lastAdv = advEntries[advEntries.length - 1] || null;
  const adversary = {
    available: fs.existsSync(adversaryRunLedgerPath),
    totalRuns: advEntries.length,
    last: lastAdv ? {
      runId: lastAdv.runId,
      sequence: lastAdv.sequence,
      startedAt: lastAdv.startedAt,
      attackCount: lastAdv.attackCount,
      catchRateAny: lastAdv.summary ? lastAdv.summary.catchRateAny : null,
    } : null,
  };

  // --- Negative-Promotion section -------------------------------------
  const negPromEntries = readJsonlTail(negPromLedgerPath);
  const negPromUniqueEntries = new Set(negPromEntries.map((e) => e.entryId));
  const negProm = {
    available: fs.existsSync(negPromLedgerPath),
    totalEvents: negPromEntries.length,
    distinctEntriesPenalized: negPromUniqueEntries.size,
  };

  // --- Architect-Review section ---------------------------------------
  const archEntries = readJsonlTail(archReviewLedgerPath);
  const archByStatus = { queued: 0, 'signed-approve': 0, 'signed-reject': 0, overdue: 0 };
  const archItemsLatest = new Map();
  for (const e of archEntries) {
    if (e.itemId) archItemsLatest.set(e.itemId, e);
  }
  const nowMs = Date.now();
  for (const latest of archItemsLatest.values()) {
    let s = latest.statusAfter || 'queued';
    if (s === 'queued' && latest.dueAt && Date.parse(latest.dueAt) < nowMs) s = 'overdue';
    if (archByStatus[s] != null) archByStatus[s]++;
  }
  const archReview = {
    available: fs.existsSync(archReviewLedgerPath),
    totalItems: archItemsLatest.size,
    byStatus: archByStatus,
  };

  // --- Decay section --------------------------------------------------
  // Sample the live KB if a store is provided in deps.
  let decay = { available: false, note: 'pass deps.store to compute live decay' };
  if (deps.store) {
    try {
      const { evaluateCorpus } = deps.decayPolicy || require('./decay-policy');
      const entries = (deps.store.listEntries(project) || []).map((e) => ({
        id: e.id, project, category: e.category, createdAt: e.createdAt, confidence: e.confidence,
      }));
      const result = evaluateCorpus(entries);
      decay = {
        available: true,
        project,
        total: result.total,
        counts: result.counts,
        archiveCandidateCount: result.archiveCandidates.length,
      };
    } catch (err) {
      decay = { available: false, error: err.message };
    }
  }

  // --- Health roll-up -------------------------------------------------
  const issues = [];
  if (!egress.available) issues.push('egress scanner has no ledger entries yet — invoke once to confirm wiring');
  if (anchor.totalAnchors === 0) issues.push('no graph anchor exists — run `recall security anchor-create`');
  if (canaries.totalPlanted === 0) issues.push('no canaries planted — run `recall security canary-plant`');
  if (drift.decision === 'critical') issues.push(`defense drift CRITICAL — ${drift.topDrift && drift.topDrift.detail}`);
  if (decay.archiveCandidateCount > 0) issues.push(`${decay.archiveCandidateCount} entry/ies past confidence floor — review for archive`);
  if (archReview.byStatus.overdue > 0) issues.push(`${archReview.byStatus.overdue} architect-review item(s) OVERDUE — sign with: recall security arch-review-sign`);
  if (auditIngest.byStatus.untrusted > 50) issues.push(`${auditIngest.byStatus.untrusted} untrusted audit records pending review — promote or reject via recall security audit-promote/reject`);
  if (adversary.last && adversary.last.catchRateAny != null && adversary.last.catchRateAny < 0.9) issues.push(`adversary catch rate ${(adversary.last.catchRateAny * 100).toFixed(0)}% — a defense gap exists`);

  let overallStatus;
  if (issues.length === 0) overallStatus = 'green';
  else if (issues.some((i) => i.includes('CRITICAL'))) overallStatus = 'red';
  else if (issues.some((i) => i.includes('drift') || i.includes('archive'))) overallStatus = 'yellow';
  else overallStatus = 'gray';

  return {
    generatedAt: new Date().toISOString(),
    project,
    windowHours,
    overallStatus,
    issues,
    egress,
    anchor,
    canaries,
    dream,
    drift,
    decay,
    auditIngest,
    adversary,
    negProm,
    archReview,
  };
}

module.exports = {
  buildDashboard,
};
