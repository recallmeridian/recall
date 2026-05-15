'use strict';

const {
  evaluateEntry,
  evaluateCorpus,
  effectiveDecay,
  tierFor,
  DEFAULT_TIERS,
} = require('../lib/security/decay-policy');

const NOW = Date.parse('2026-05-13T00:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 60 * 60 * 1000).toISOString();

describe('decay-policy: effective decay', () => {
  test('decay = 1 at age 0', () => {
    expect(effectiveDecay(0, 24)).toBe(1);
  });

  test('decay = 0.5 at one half-life', () => {
    expect(effectiveDecay(24, 24)).toBeCloseTo(0.5, 6);
  });

  test('decay = 0.25 at two half-lives', () => {
    expect(effectiveDecay(48, 24)).toBeCloseTo(0.25, 6);
  });

  test('decay = 1 for nonsense inputs', () => {
    expect(effectiveDecay(-5, 24)).toBe(1);
    expect(effectiveDecay(10, 0)).toBe(1);
  });
});

describe('decay-policy: tierFor', () => {
  test('explicit decayTier wins', () => {
    expect(tierFor({ decayTier: 'denylist', category: 'decisions' })).toBe('denylist');
  });

  test('category mapping fallback', () => {
    expect(tierFor({ category: 'decisions' })).toBe('ridge.validated');
    expect(tierFor({ category: 'milestones' })).toBe('ridge.canonical');
    expect(tierFor({ category: 'imports' })).toBe('basin.raw');
  });

  test('unknown category → basin.classified by default', () => {
    expect(tierFor({ category: 'unknown' })).toBe('basin.classified');
  });

  test('opts.defaultTier override applies', () => {
    expect(tierFor({ category: 'unknown' }, { defaultTier: 'basin.raw' })).toBe('basin.raw');
  });
});

describe('decay-policy: evaluateEntry', () => {
  test('fresh basin entry → fresh', () => {
    const r = evaluateEntry({ id: 'e1', category: 'imports', createdAt: hoursAgo(1), confidence: 1 }, { nowMs: NOW });
    expect(r.tier).toBe('basin.raw');
    expect(r.status).toBe('fresh');
    expect(r.effectiveConfidence).toBeGreaterThan(0.9);
  });

  test('basin entry past 1 half-life → aging', () => {
    const r = evaluateEntry({ id: 'e1', category: 'imports', createdAt: hoursAgo(30), confidence: 1 }, { nowMs: NOW });
    expect(r.tier).toBe('basin.raw');
    expect(['aging', 'stale']).toContain(r.status);
    expect(r.effectiveConfidence).toBeLessThan(0.5);
  });

  test('basin entry far past floor → archive', () => {
    const r = evaluateEntry({ id: 'e1', category: 'imports', createdAt: hoursAgo(24 * 7), confidence: 1 }, { nowMs: NOW });
    expect(r.status).toBe('archive');
  });

  test('canonical ridge entry stays fresh for months', () => {
    const r = evaluateEntry({ id: 'e1', category: 'milestones', createdAt: hoursAgo(24 * 60), confidence: 1 }, { nowMs: NOW });
    expect(r.tier).toBe('ridge.canonical');
    expect(r.status).toBe('fresh');
  });

  test('denylist entry decays in hours → archive quickly', () => {
    const r = evaluateEntry({ id: 'e1', decayTier: 'denylist', createdAt: hoursAgo(5), confidence: 1 }, { nowMs: NOW });
    expect(r.tier).toBe('denylist');
    // 5 half-lives = decay factor 1/32 = 0.03125 — well below floor 0.5
    expect(r.status).toBe('archive');
  });

  test('low base confidence accelerates archive', () => {
    const high = evaluateEntry({ id: 'e1', category: 'decisions', createdAt: hoursAgo(24 * 30), confidence: 1 }, { nowMs: NOW });
    const low = evaluateEntry({ id: 'e2', category: 'decisions', createdAt: hoursAgo(24 * 30), confidence: 0.3 }, { nowMs: NOW });
    expect(low.effectiveConfidence).toBeLessThan(high.effectiveConfidence);
  });

  test('explicit ageHours overrides createdAt', () => {
    const r = evaluateEntry({ id: 'e1', category: 'imports', createdAt: hoursAgo(1), confidence: 1 }, { nowMs: NOW, ageHours: 24 * 7 });
    expect(r.ageHours).toBe(24 * 7);
    expect(r.status).toBe('archive');
  });

  test('rolls back to fresh with custom thresholds', () => {
    const r = evaluateEntry({ id: 'e1', category: 'imports', createdAt: hoursAgo(20), confidence: 1 }, { nowMs: NOW, agingThreshold: 0.4, staleThreshold: 0.1 });
    expect(['fresh', 'aging']).toContain(r.status);
  });
});

describe('decay-policy: evaluateCorpus', () => {
  test('mixed corpus produces correct counts and archive list', () => {
    const entries = [
      { id: 'a', category: 'milestones',  createdAt: hoursAgo(1),     confidence: 1 },     // ridge.canonical fresh
      { id: 'b', category: 'imports',     createdAt: hoursAgo(72),    confidence: 1 },     // basin.raw aging/stale
      { id: 'c', category: 'imports',     createdAt: hoursAgo(24 * 7), confidence: 1 },    // basin.raw archive
      { id: 'd', category: 'decisions',   createdAt: hoursAgo(24 * 60), confidence: 0.8 }, // ridge.validated mostly fresh
    ];
    const r = evaluateCorpus(entries, { nowMs: NOW });
    expect(r.total).toBe(4);
    expect(r.counts.fresh + r.counts.aging + r.counts.stale + r.counts.archive).toBe(4);
    expect(r.archiveCandidates.length).toBeGreaterThanOrEqual(1);
    expect(r.archiveCandidates.find((e) => e.entryId === 'c')).toBeTruthy();
  });

  test('empty corpus → zero counts', () => {
    const r = evaluateCorpus([], { nowMs: NOW });
    expect(r.total).toBe(0);
    expect(r.archiveCandidates).toEqual([]);
  });
});
