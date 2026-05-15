'use strict';

// Drift detector on defense efficacy — §8 wiring gap from the
// 2026-05-12 brainstorm.
//
// Operational defenses (egress DLP, governor, promotion gate) emit
// outcomes over time. A defense that USED to catch attacks at rate X
// and now catches at rate X' < X is drifting — either the threat
// surface shifted, or the defense itself silently degraded (config
// drift, dependency change, regex regression).
//
// What this detects, given two windows of defense outcomes:
//   • block-rate change beyond tolerance
//   • false-positive-rate change beyond tolerance
//   • coverage drop (fewer scans than a baseline frequency would
//     produce — the defense isn't being invoked when it should be)
//   • detector-mix change (which detectors are firing differs
//     significantly from baseline — surface is changing or detector
//     is changing)
//
// API:
//   evaluateDrift({ baseline, current, tolerances? })
//     → {
//         decision: 'no-drift' | 'monitor' | 'investigate' | 'critical',
//         drifts: [{ axis, before, after, delta, severity, detail }],
//         summary,
//       }
//
// `baseline` and `current` are summary stats over a window:
//   {
//     windowHours,
//     scanCount,           // how many DLP scans ran
//     blockRate,           // fraction of scans that were 'block'
//     reviewRate,          // fraction that were 'review'
//     allowRate,           // fraction that were 'allow'
//     falsePositiveRate?,  // optional, if measurable
//     detectorMix?: { [detectorId]: hits }  // optional fingerprint
//   }

function _detectorMixDistance(a = {}, b = {}) {
  // L1 distance (Manhattan) on normalized detector mix vectors. 0
  // means identical fingerprints; 2 means completely disjoint.
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (allKeys.size === 0) return 0;
  const sumA = Object.values(a).reduce((acc, v) => acc + v, 0) || 1;
  const sumB = Object.values(b).reduce((acc, v) => acc + v, 0) || 1;
  let dist = 0;
  for (const k of allKeys) {
    const pa = (a[k] || 0) / sumA;
    const pb = (b[k] || 0) / sumB;
    dist += Math.abs(pa - pb);
  }
  return dist;
}

const DEFAULT_TOLERANCES = {
  blockRateAbsMax: 0.15,        // block rate may shift up to 15 percentage points
  reviewRateAbsMax: 0.20,
  falsePositiveRateAbsMax: 0.05,
  scanCountRelMax: 0.40,        // up to 40% drop in scan frequency tolerated
  detectorMixL1Max: 0.40,       // detector fingerprint shift in L1 distance
};

function evaluateDrift({ baseline, current, tolerances } = {}) {
  if (!baseline || !current) {
    return { decision: 'no-baseline', drifts: [], summary: { reason: 'baseline or current window missing' } };
  }
  const tol = { ...DEFAULT_TOLERANCES, ...(tolerances || {}) };
  const drifts = [];

  // Block rate
  if (typeof baseline.blockRate === 'number' && typeof current.blockRate === 'number') {
    const delta = current.blockRate - baseline.blockRate;
    if (Math.abs(delta) > tol.blockRateAbsMax) {
      drifts.push({
        axis: 'blockRate',
        before: baseline.blockRate,
        after: current.blockRate,
        delta,
        severity: Math.abs(delta) > tol.blockRateAbsMax * 2 ? 'critical' : 'investigate',
        detail: delta < 0
          ? `block rate dropped by ${(Math.abs(delta) * 100).toFixed(1)}pp — defense may be missing attacks`
          : `block rate rose by ${(delta * 100).toFixed(1)}pp — surface changed or detector tightened`,
      });
    }
  }

  // Review rate
  if (typeof baseline.reviewRate === 'number' && typeof current.reviewRate === 'number') {
    const delta = current.reviewRate - baseline.reviewRate;
    if (Math.abs(delta) > tol.reviewRateAbsMax) {
      drifts.push({
        axis: 'reviewRate',
        before: baseline.reviewRate,
        after: current.reviewRate,
        delta,
        severity: 'monitor',
        detail: `review rate shifted by ${(delta * 100).toFixed(1)}pp`,
      });
    }
  }

  // False-positive rate
  if (typeof baseline.falsePositiveRate === 'number' && typeof current.falsePositiveRate === 'number') {
    const delta = current.falsePositiveRate - baseline.falsePositiveRate;
    if (Math.abs(delta) > tol.falsePositiveRateAbsMax) {
      drifts.push({
        axis: 'falsePositiveRate',
        before: baseline.falsePositiveRate,
        after: current.falsePositiveRate,
        delta,
        severity: delta > 0 ? 'investigate' : 'monitor',
        detail: delta > 0
          ? `FP rate rose by ${(delta * 100).toFixed(1)}pp — alert fatigue risk`
          : `FP rate fell by ${(Math.abs(delta) * 100).toFixed(1)}pp`,
      });
    }
  }

  // Coverage / scan-count drop
  if (typeof baseline.scanCount === 'number' && typeof current.scanCount === 'number') {
    const baselinePerHour = baseline.windowHours ? baseline.scanCount / baseline.windowHours : null;
    const currentPerHour = current.windowHours ? current.scanCount / current.windowHours : null;
    // currentPerHour can legitimately be 0 (defense not invoked at
    // all in the current window). DON'T short-circuit on falsy here.
    if (typeof baselinePerHour === 'number' && typeof currentPerHour === 'number' && baselinePerHour > 0) {
      const relDelta = (currentPerHour - baselinePerHour) / baselinePerHour;
      if (relDelta < -tol.scanCountRelMax) {
        drifts.push({
          axis: 'scanFrequency',
          before: baselinePerHour,
          after: currentPerHour,
          delta: relDelta,
          severity: 'critical',
          detail: `scan frequency dropped ${(Math.abs(relDelta) * 100).toFixed(0)}% — defense may not be invoked`,
        });
      } else if (relDelta > tol.scanCountRelMax) {
        drifts.push({
          axis: 'scanFrequency',
          before: baselinePerHour,
          after: currentPerHour,
          delta: relDelta,
          severity: 'monitor',
          detail: `scan frequency rose ${(relDelta * 100).toFixed(0)}% — increased exposure or testing`,
        });
      }
    }
  }

  // Detector mix
  if (baseline.detectorMix && current.detectorMix) {
    const distance = _detectorMixDistance(baseline.detectorMix, current.detectorMix);
    if (distance > tol.detectorMixL1Max) {
      drifts.push({
        axis: 'detectorMix',
        before: baseline.detectorMix,
        after: current.detectorMix,
        delta: distance,
        severity: distance > tol.detectorMixL1Max * 2 ? 'critical' : 'investigate',
        detail: `detector fingerprint distance ${distance.toFixed(2)} (max ${tol.detectorMixL1Max}) — surface or detector composition shifted`,
      });
    }
  }

  let decision;
  if (drifts.length === 0) decision = 'no-drift';
  else if (drifts.some((d) => d.severity === 'critical')) decision = 'critical';
  else if (drifts.some((d) => d.severity === 'investigate')) decision = 'investigate';
  else decision = 'monitor';

  return {
    decision,
    drifts,
    summary: {
      driftCount: drifts.length,
      criticalCount: drifts.filter((d) => d.severity === 'critical').length,
      investigateCount: drifts.filter((d) => d.severity === 'investigate').length,
      monitorCount: drifts.filter((d) => d.severity === 'monitor').length,
      tolerances: tol,
    },
  };
}

// Helper: summarize a slice of an egress-scan ledger into the
// {scanCount, blockRate, reviewRate, allowRate, detectorMix,
//  windowHours} shape evaluateDrift expects.
function summarizeLedger(entries, windowHours) {
  const counts = { block: 0, review: 0, allow: 0 };
  const detectorMix = {};
  for (const e of entries) {
    if (e.decision in counts) counts[e.decision]++;
    for (const id of (e.blockerIds || [])) {
      detectorMix[id] = (detectorMix[id] || 0) + 1;
    }
    for (const id of (e.warningIds || [])) {
      detectorMix[id] = (detectorMix[id] || 0) + 1;
    }
  }
  const total = counts.block + counts.review + counts.allow;
  return {
    windowHours,
    scanCount: total,
    blockRate: total ? counts.block / total : 0,
    reviewRate: total ? counts.review / total : 0,
    allowRate: total ? counts.allow / total : 0,
    detectorMix,
  };
}

module.exports = {
  evaluateDrift,
  summarizeLedger,
  DEFAULT_TOLERANCES,
};
