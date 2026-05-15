'use strict';

const { evaluateDrift, summarizeLedger } = require('../lib/security/drift-detector');

const baseSummary = (overrides = {}) => ({
  windowHours: 24,
  scanCount: 100,
  blockRate: 0.10,
  reviewRate: 0.20,
  allowRate: 0.70,
  falsePositiveRate: 0.02,
  detectorMix: { 'absolute-windows-user-path': 5, 'env-credential-line': 5 },
  ...overrides,
});

describe('drift-detector: evaluateDrift', () => {
  test('identical windows → no-drift', () => {
    const r = evaluateDrift({ baseline: baseSummary(), current: baseSummary() });
    expect(r.decision).toBe('no-drift');
    expect(r.drifts).toHaveLength(0);
  });

  test('block-rate plunge → investigate or critical', () => {
    const r = evaluateDrift({ baseline: baseSummary({ blockRate: 0.50 }), current: baseSummary({ blockRate: 0.05 }) });
    expect(['investigate', 'critical']).toContain(r.decision);
    expect(r.drifts.some((d) => d.axis === 'blockRate' && d.delta < 0)).toBe(true);
  });

  test('block-rate spike beyond 2x tolerance → critical', () => {
    const r = evaluateDrift({ baseline: baseSummary({ blockRate: 0.05 }), current: baseSummary({ blockRate: 0.50 }) });
    expect(r.decision).toBe('critical');
  });

  test('FP rate increase → investigate (alert fatigue)', () => {
    const r = evaluateDrift({ baseline: baseSummary({ falsePositiveRate: 0.01 }), current: baseSummary({ falsePositiveRate: 0.10 }) });
    expect(r.decision).toBe('investigate');
    expect(r.drifts.some((d) => d.axis === 'falsePositiveRate')).toBe(true);
  });

  test('scan frequency drop → critical (defense not invoked)', () => {
    const baseline = baseSummary({ scanCount: 100, windowHours: 24 });
    const current  = baseSummary({ scanCount: 10, windowHours: 24 });
    const r = evaluateDrift({ baseline, current });
    expect(r.decision).toBe('critical');
    expect(r.drifts.some((d) => d.axis === 'scanFrequency' && d.delta < 0)).toBe(true);
  });

  test('detector mix shift beyond L1 distance → investigate', () => {
    const r = evaluateDrift({
      baseline: baseSummary({ detectorMix: { 'a': 50, 'b': 50 } }),
      current:  baseSummary({ detectorMix: { 'a': 5, 'b': 95 } }),
    });
    expect(['investigate', 'critical']).toContain(r.decision);
    expect(r.drifts.some((d) => d.axis === 'detectorMix')).toBe(true);
  });

  test('completely disjoint detector mix → critical', () => {
    const r = evaluateDrift({
      baseline: baseSummary({ detectorMix: { 'a': 100 } }),
      current:  baseSummary({ detectorMix: { 'z': 100 } }),
    });
    expect(r.decision).toBe('critical');
  });

  test('missing baseline → no-baseline', () => {
    const r = evaluateDrift({ current: baseSummary() });
    expect(r.decision).toBe('no-baseline');
  });

  test('multiple drifts → highest severity wins decision', () => {
    const baseline = baseSummary({ blockRate: 0.10, scanCount: 100, windowHours: 24 });
    const current  = baseSummary({ blockRate: 0.01, scanCount: 10,  windowHours: 24 });
    const r = evaluateDrift({ baseline, current });
    expect(r.decision).toBe('critical');
    expect(r.summary.criticalCount).toBeGreaterThanOrEqual(1);
  });

  test('custom tolerances tighten or loosen the gate', () => {
    const tighter = evaluateDrift({
      baseline: baseSummary({ blockRate: 0.10 }),
      current:  baseSummary({ blockRate: 0.20 }),
      tolerances: { blockRateAbsMax: 0.05 },
    });
    expect(tighter.drifts.some((d) => d.axis === 'blockRate')).toBe(true);
  });
});

describe('drift-detector: summarizeLedger', () => {
  test('summarizes block/review/allow counts and detector mix', () => {
    const entries = [
      { decision: 'block', blockerIds: ['a', 'b'], warningIds: [] },
      { decision: 'block', blockerIds: ['a'],      warningIds: [] },
      { decision: 'review', blockerIds: [],        warningIds: ['c'] },
      { decision: 'allow',  blockerIds: [],        warningIds: [] },
    ];
    const r = summarizeLedger(entries, 24);
    expect(r.scanCount).toBe(4);
    expect(r.blockRate).toBe(0.5);
    expect(r.reviewRate).toBe(0.25);
    expect(r.allowRate).toBe(0.25);
    expect(r.detectorMix).toEqual({ 'a': 2, 'b': 1, 'c': 1 });
    expect(r.windowHours).toBe(24);
  });

  test('empty entries → all-zero summary', () => {
    const r = summarizeLedger([], 24);
    expect(r.scanCount).toBe(0);
    expect(r.blockRate).toBe(0);
  });
});
