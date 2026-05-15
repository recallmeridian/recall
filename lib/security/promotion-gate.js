'use strict';

// Vector Promotion Gate — Slice #5 of Codex's 5-slice OpenClaw security
// build order from the 2026-05-12 brainstorm.
//
// Replaces single "good/bad" promotion scoring with a multi-objective
// constraint-satisfaction gate. Codex's exact spec:
//
//   Promote only if:
//     - no critical regression
//     - false positives below threshold
//     - egress risk does not increase
//     - audit integrity remains valid
//     - at least one meaningful defense metric improves
//     - human approves if external posting or tool authority changes
//
// Hardening kernel invariant: never auto-promote live-write defenses.
// The gate enforces this independently of the constraint vector.
//
// API: evaluatePromotion({ before, after, context }) → {
//   decision: 'promote' | 'block' | 'requires_approval',
//   constraints: [{ name, satisfied, detail }],
//   improvements: [...],
//   regressions: [...],
//   reason,
// }
//
// `before` and `after` are vector measurements with the same shape:
//   {
//     blockedAttacks?, allowedLegitimateActions?, falsePositiveRate?,
//     falseNegativeRate?, approvalBurden?, latencyMs?, userFriction?,
//     egressRisk?, terrainCoherenceDelta?, rollbackReadiness?,
//     auditIntegrity? ('valid'|'invalid'|'unknown'),
//     defenseMetrics?: { [name]: number }
//   }
//
// `context` declares the change shape:
//   {
//     touchesExternalAuthority?: boolean — public posting / tool auth changes
//     touchesLiveWrite?: boolean — affects live-write surface
//     thresholds?: { falsePositiveRateMax, regressionRelMax,
//                    egressRiskAbsMax }
//   }

const DEFAULT_THRESHOLDS = {
  falsePositiveRateMax: 0.05,
  // Max relative regression in any axis where lower-is-better became
  // higher (e.g. latency went from 100ms to 130ms = 0.30 regression).
  regressionRelMax: 0.20,
  // Egress risk is treated as already-quantified (0..1). After must
  // be <= before + this delta.
  egressRiskAbsMax: 0.0,
};

// Whether a metric is "lower is better" — a regression means it went UP.
const LOWER_IS_BETTER = new Set([
  'falsePositiveRate', 'falseNegativeRate', 'approvalBurden',
  'latencyMs', 'userFriction', 'egressRisk',
]);

// Whether a metric is "higher is better" — a regression means it went DOWN.
const HIGHER_IS_BETTER = new Set([
  'blockedAttacks', 'allowedLegitimateActions', 'rollbackReadiness',
  'terrainCoherenceDelta',
]);

function relChange(before, after) {
  if (before === undefined || before === null) return null;
  if (after === undefined || after === null) return null;
  if (before === 0) return after === 0 ? 0 : (after > 0 ? Infinity : -Infinity);
  return (after - before) / Math.abs(before);
}

function isCriticalRegression(metric, before, after, thresholds) {
  if (LOWER_IS_BETTER.has(metric)) {
    const rel = relChange(before, after);
    if (rel === null) return false;
    return rel > thresholds.regressionRelMax;
  }
  if (HIGHER_IS_BETTER.has(metric)) {
    const rel = relChange(before, after);
    if (rel === null) return false;
    return -rel > thresholds.regressionRelMax;
  }
  return false;
}

function evaluatePromotion({ before = {}, after = {}, context = {} } = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(context.thresholds || {}) };
  const constraints = [];
  const improvements = [];
  const regressions = [];

  // Walk every measured axis in either before or after.
  const axes = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const axis of axes) {
    if (axis === 'auditIntegrity' || axis === 'defenseMetrics') continue;
    const b = before[axis];
    const a = after[axis];
    if (typeof a !== 'number' && typeof b !== 'number') continue;
    if (isCriticalRegression(axis, b, a, thresholds)) {
      regressions.push({ axis, before: b, after: a, relChange: relChange(b, a) });
    } else if (LOWER_IS_BETTER.has(axis) && typeof b === 'number' && typeof a === 'number' && a < b) {
      improvements.push({ axis, before: b, after: a, relChange: relChange(b, a) });
    } else if (HIGHER_IS_BETTER.has(axis) && typeof b === 'number' && typeof a === 'number' && a > b) {
      improvements.push({ axis, before: b, after: a, relChange: relChange(b, a) });
    }
  }

  // Treat each defenseMetrics entry as higher-is-better.
  const beforeDefenseMetrics = before.defenseMetrics || {};
  const afterDefenseMetrics = after.defenseMetrics || {};
  const defenseAxes = new Set([...Object.keys(beforeDefenseMetrics), ...Object.keys(afterDefenseMetrics)]);
  for (const axis of defenseAxes) {
    const b = beforeDefenseMetrics[axis];
    const a = afterDefenseMetrics[axis];
    if (typeof a !== 'number' && typeof b !== 'number') continue;
    const rel = relChange(b, a);
    if (rel !== null && -rel > thresholds.regressionRelMax) {
      regressions.push({ axis: 'defense:' + axis, before: b, after: a, relChange: rel });
    } else if (typeof b === 'number' && typeof a === 'number' && a > b) {
      improvements.push({ axis: 'defense:' + axis, before: b, after: a, relChange: rel });
    }
  }

  // Constraint #1: no critical regression
  constraints.push({
    name: 'no_critical_regression',
    satisfied: regressions.length === 0,
    detail: regressions.length === 0 ? 'no axes regressed beyond threshold' : `${regressions.length} regression(s): ${regressions.map((r) => r.axis).join(', ')}`,
  });

  // Constraint #2: FP rate below threshold (after-state)
  const fpAfter = after.falsePositiveRate;
  constraints.push({
    name: 'false_positives_below_threshold',
    satisfied: fpAfter === undefined || fpAfter === null || fpAfter <= thresholds.falsePositiveRateMax,
    detail: fpAfter === undefined ? 'falsePositiveRate not measured' : `falsePositiveRate=${fpAfter} (max=${thresholds.falsePositiveRateMax})`,
  });

  // Constraint #3: egress risk does not increase
  const egBefore = before.egressRisk;
  const egAfter = after.egressRisk;
  let egressOK = true;
  if (typeof egBefore === 'number' && typeof egAfter === 'number') {
    egressOK = (egAfter - egBefore) <= thresholds.egressRiskAbsMax;
  }
  constraints.push({
    name: 'egress_risk_not_increased',
    satisfied: egressOK,
    detail: typeof egBefore === 'number' && typeof egAfter === 'number'
      ? `before=${egBefore}, after=${egAfter} (Δ=${(egAfter - egBefore).toFixed(4)}, max=${thresholds.egressRiskAbsMax})`
      : 'egressRisk not measured on both sides',
  });

  // Constraint #4: audit integrity valid
  const auditAfter = after.auditIntegrity;
  constraints.push({
    name: 'audit_integrity_valid',
    satisfied: auditAfter === 'valid' || auditAfter === undefined,
    detail: auditAfter ? `auditIntegrity=${auditAfter}` : 'auditIntegrity not measured (treated as not-failing)',
  });

  // Constraint #5: at least one meaningful defense improvement
  const hasMeaningfulImprovement = improvements.length > 0;
  constraints.push({
    name: 'at_least_one_defense_improvement',
    satisfied: hasMeaningfulImprovement,
    detail: hasMeaningfulImprovement
      ? `${improvements.length} improvement(s): ${improvements.map((i) => i.axis).join(', ')}`
      : 'no measurable improvement on any axis',
  });

  // Kernel invariant: live-write defenses are NEVER auto-promoted.
  if (context.touchesLiveWrite) {
    constraints.push({
      name: 'live_write_never_auto_promote',
      satisfied: false,
      detail: 'kernel invariant: live-write defenses require explicit human approval (cannot be satisfied by metrics)',
    });
  }

  // Constraint #6: human approval required if external authority changes
  if (context.touchesExternalAuthority || context.touchesLiveWrite) {
    constraints.push({
      name: 'human_approval_required',
      satisfied: Boolean(context.humanApprovalGranted),
      detail: context.touchesLiveWrite
        ? 'live-write authority change — requires explicit human approval'
        : 'external posting / tool authority change — requires explicit human approval',
    });
  }

  const failed = constraints.filter((c) => !c.satisfied);
  let decision;
  let reason;
  if (failed.length === 0) {
    decision = 'promote';
    reason = 'all constraints satisfied';
  } else {
    const onlyHumanApprovalFailing = failed.length === 1 && failed[0].name === 'human_approval_required';
    if (onlyHumanApprovalFailing) {
      decision = 'requires_approval';
      reason = 'metrics pass but external/live-write authority change requires explicit human approval';
    } else {
      decision = 'block';
      reason = failed.map((c) => c.name).join(', ');
    }
  }

  return {
    decision,
    reason,
    constraints,
    improvements,
    regressions,
    thresholds,
  };
}

module.exports = {
  evaluatePromotion,
  DEFAULT_THRESHOLDS,
  LOWER_IS_BETTER,
  HIGHER_IS_BETTER,
};
