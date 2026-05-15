'use strict';

const { evaluatePromotion } = require('../lib/security/promotion-gate');

describe('vector promotion gate', () => {
  test('promote when at least one improvement and no regressions', () => {
    const r = evaluatePromotion({
      before: { blockedAttacks: 10, falsePositiveRate: 0.04, latencyMs: 100, auditIntegrity: 'valid', egressRisk: 0.1 },
      after:  { blockedAttacks: 12, falsePositiveRate: 0.04, latencyMs: 100, auditIntegrity: 'valid', egressRisk: 0.1 },
      context: {},
    });
    expect(r.decision).toBe('promote');
    expect(r.improvements.some((i) => i.axis === 'blockedAttacks')).toBe(true);
    expect(r.regressions).toHaveLength(0);
  });

  test('block when a critical regression appears (latency up >threshold)', () => {
    const r = evaluatePromotion({
      before: { blockedAttacks: 10, latencyMs: 100, auditIntegrity: 'valid' },
      after:  { blockedAttacks: 12, latencyMs: 200, auditIntegrity: 'valid' },
      context: {},
    });
    expect(r.decision).toBe('block');
    expect(r.regressions.some((r) => r.axis === 'latencyMs')).toBe(true);
  });

  test('block when false positive rate exceeds threshold', () => {
    const r = evaluatePromotion({
      before: { falsePositiveRate: 0.04, blockedAttacks: 10 },
      after:  { falsePositiveRate: 0.10, blockedAttacks: 11 },
      context: { thresholds: { falsePositiveRateMax: 0.05 } },
    });
    expect(r.decision).toBe('block');
    expect(r.constraints.find((c) => c.name === 'false_positives_below_threshold').satisfied).toBe(false);
  });

  test('block when egress risk increases', () => {
    const r = evaluatePromotion({
      before: { egressRisk: 0.1, blockedAttacks: 10 },
      after:  { egressRisk: 0.2, blockedAttacks: 11 },
      context: {},
    });
    expect(r.decision).toBe('block');
    expect(r.constraints.find((c) => c.name === 'egress_risk_not_increased').satisfied).toBe(false);
  });

  test('block when audit integrity becomes invalid', () => {
    const r = evaluatePromotion({
      before: { auditIntegrity: 'valid', blockedAttacks: 10 },
      after:  { auditIntegrity: 'invalid', blockedAttacks: 11 },
      context: {},
    });
    expect(r.decision).toBe('block');
    expect(r.constraints.find((c) => c.name === 'audit_integrity_valid').satisfied).toBe(false);
  });

  test('block when no improvements measured anywhere', () => {
    const r = evaluatePromotion({
      before: { blockedAttacks: 10, latencyMs: 100, auditIntegrity: 'valid' },
      after:  { blockedAttacks: 10, latencyMs: 100, auditIntegrity: 'valid' },
      context: {},
    });
    expect(r.decision).toBe('block');
    expect(r.constraints.find((c) => c.name === 'at_least_one_defense_improvement').satisfied).toBe(false);
  });

  test('requires_approval when external authority changes (metrics pass otherwise)', () => {
    const r = evaluatePromotion({
      before: { blockedAttacks: 10, auditIntegrity: 'valid' },
      after:  { blockedAttacks: 12, auditIntegrity: 'valid' },
      context: { touchesExternalAuthority: true },
    });
    expect(r.decision).toBe('requires_approval');
  });

  test('promotes when external authority changes AND human approval granted', () => {
    const r = evaluatePromotion({
      before: { blockedAttacks: 10, auditIntegrity: 'valid' },
      after:  { blockedAttacks: 12, auditIntegrity: 'valid' },
      context: { touchesExternalAuthority: true, humanApprovalGranted: true },
    });
    expect(r.decision).toBe('promote');
  });

  test('NEVER auto-promotes live-write even with metrics passing AND approval flag', () => {
    const r = evaluatePromotion({
      before: { blockedAttacks: 10, auditIntegrity: 'valid' },
      after:  { blockedAttacks: 12, auditIntegrity: 'valid' },
      context: { touchesLiveWrite: true, humanApprovalGranted: true },
    });
    // The kernel invariant constraint live_write_never_auto_promote
    // is unsatisfiable by metrics. Even with humanApprovalGranted, the
    // gate produces 'block' because the kernel constraint stands.
    expect(r.decision).toBe('block');
    expect(r.constraints.find((c) => c.name === 'live_write_never_auto_promote').satisfied).toBe(false);
  });

  test('multiple constraints fail → reason cites all', () => {
    const r = evaluatePromotion({
      before: { falsePositiveRate: 0.02, egressRisk: 0.1, auditIntegrity: 'valid', blockedAttacks: 10 },
      after:  { falsePositiveRate: 0.20, egressRisk: 0.2, auditIntegrity: 'invalid', blockedAttacks: 10 },
      context: {},
    });
    expect(r.decision).toBe('block');
    expect(r.reason).toContain('false_positives_below_threshold');
    expect(r.reason).toContain('egress_risk_not_increased');
    expect(r.reason).toContain('audit_integrity_valid');
    expect(r.reason).toContain('at_least_one_defense_improvement');
  });

  test('defense metric improvements count', () => {
    const r = evaluatePromotion({
      before: { defenseMetrics: { canaryCatchRate: 0.5 }, auditIntegrity: 'valid' },
      after:  { defenseMetrics: { canaryCatchRate: 0.8 }, auditIntegrity: 'valid' },
      context: {},
    });
    expect(r.decision).toBe('promote');
    expect(r.improvements.some((i) => i.axis === 'defense:canaryCatchRate')).toBe(true);
  });

  test('defense metric regressions count', () => {
    const r = evaluatePromotion({
      before: { defenseMetrics: { canaryCatchRate: 0.8 }, auditIntegrity: 'valid', blockedAttacks: 10 },
      after:  { defenseMetrics: { canaryCatchRate: 0.4 }, auditIntegrity: 'valid', blockedAttacks: 11 },
      context: {},
    });
    expect(r.decision).toBe('block');
    expect(r.regressions.some((r) => r.axis === 'defense:canaryCatchRate')).toBe(true);
  });

  test('higher-is-better decrease beyond threshold is a regression', () => {
    const r = evaluatePromotion({
      before: { blockedAttacks: 100, auditIntegrity: 'valid', falsePositiveRate: 0.02 },
      after:  { blockedAttacks: 70, auditIntegrity: 'valid', falsePositiveRate: 0.02 },
      context: {},
    });
    expect(r.decision).toBe('block');
    expect(r.regressions.some((r) => r.axis === 'blockedAttacks')).toBe(true);
  });
});
