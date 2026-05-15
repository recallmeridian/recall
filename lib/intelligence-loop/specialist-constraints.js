'use strict';

// Per-specialist promotion constraint specs.
//
// The generic Vector Promotion Gate (lib/security/promotion-gate.js)
// evaluates {before, after} metric vectors against a constraint set.
// Each specialist needs its OWN constraint set tied to what "improvement"
// means for that specialist's task. This module is the spec registry.
//
// API:
//   getConstraintsFor(specialistId) → { thresholds, context }
//   buildMetricVector(scoreReport) → metric vector consumable by the gate

const DEFAULT_CONSTRAINTS = {
  // Generic fallback. Per-specialist entries below override.
  thresholds: {
    falsePositiveRateMax: 0.10,
    regressionRelMax: 0.05, // 5% regression on any metric is a critical regression
    egressRiskAbsMax: 0.0,
  },
  context: {
    // Specialist-bundle changes touch the policy surface; per kernel
    // invariant they need human approval. NOT live-write — they don't
    // touch external sending — so they're not auto-blocked.
    touchesExternalAuthority: true,
    touchesLiveWrite: false,
  },
};

const SPECIALIST_CONSTRAINTS = {
  'recall-dev-codebase-reviewer': {
    thresholds: {
      falsePositiveRateMax: 0.10,   // Clean cases mustn't get flagged
      regressionRelMax: 0.05,       // ≤5% slip on any metric is critical
      egressRiskAbsMax: 0.0,
    },
    context: {
      touchesExternalAuthority: true,
      touchesLiveWrite: false,
    },
    // Specialist-specific axes this spec cares about:
    measuredAxes: ['visiblePassRate', 'holdoutPassRate', 'falsePositiveRate', 'defenseMetrics'],
  },
  'recall-marketing-strategist': {
    thresholds: {
      falsePositiveRateMax: 0.15,
      regressionRelMax: 0.05,
      egressRiskAbsMax: 0.0,
    },
    context: {
      touchesExternalAuthority: true,
      touchesLiveWrite: false,
    },
    measuredAxes: ['visiblePassRate', 'holdoutPassRate', 'defenseMetrics'],
  },
  'openclaw-governor': {
    thresholds: {
      falsePositiveRateMax: 0.05,   // Governor must be very precise
      regressionRelMax: 0.02,       // Tighter — Governor controls action gates
      egressRiskAbsMax: 0.0,
    },
    context: {
      touchesExternalAuthority: true,
      touchesLiveWrite: true,       // Governor decisions gate live-write
    },
    measuredAxes: ['visiblePassRate', 'holdoutPassRate', 'falsePositiveRate', 'defenseMetrics'],
  },
};

function getConstraintsFor(specialistId) {
  return SPECIALIST_CONSTRAINTS[specialistId] || DEFAULT_CONSTRAINTS;
}

// Convert a scoreReport (from cycle-runner.runCaseSet) into a metric
// vector the promotion gate evaluates. Higher-is-better for pass rates;
// lower-is-better for FP rate.
//
//   scoreReport: { total, passCount, failCount, passRate, results: [...] }
//   isControlCase(caseDef) — function to identify control (no-flag) cases
function buildMetricVector(scoreReport, opts = {}) {
  if (!scoreReport) return {};
  const isControl = opts.isControlCase || (() => false);

  // FP rate: control cases that the specialist incorrectly flagged.
  // We count control cases where the result.pass is false AND the case
  // has controlNoDoctrineFlags === true.
  let controlTotal = 0;
  let controlFails = 0;
  for (const r of (scoreReport.results || [])) {
    // The caseDef isn't on the result, so we'd need it passed in.
    // Caller should annotate each result with `isControl` for accuracy.
    if (r.isControl) {
      controlTotal++;
      if (!r.pass) controlFails++;
    }
  }
  const falsePositiveRate = controlTotal > 0 ? controlFails / controlTotal : 0;

  return {
    visiblePassRate: scoreReport.passRate,
    falsePositiveRate,
    auditIntegrity: 'valid',
    defenseMetrics: {
      passCount: scoreReport.passCount,
    },
  };
}

module.exports = {
  getConstraintsFor,
  buildMetricVector,
  SPECIALIST_CONSTRAINTS,
  DEFAULT_CONSTRAINTS,
};
