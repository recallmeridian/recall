'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  recordNegativePromotion,
  summarizePenalty,
  applyToConfidence,
  listEvents,
  verifyLedger,
  DEFAULT_PENALTY_FACTOR,
} = require('../lib/security/negative-promotion');

describe('reconsolidation negative-promotion events', () => {
  let dataDir;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'negprom-test-'));
  });
  afterEach(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('recordNegativePromotion writes a sequence-1 ledger entry', () => {
    const e = recordNegativePromotion(
      { entryId: 'decision-foo', source: 'specialist:codebase-reviewer', reason: 'retrieved-but-not-cited' },
      { dataDir }
    );
    expect(e.sequence).toBe(1);
    expect(e.previousHash).toBeNull();
    expect(e.entryHash).toMatch(/^sha256:/);
    expect(e.entryId).toBe('decision-foo');
    expect(e.reason).toBe('retrieved-but-not-cited');
  });

  test('hash-chain links sequential events', () => {
    const a = recordNegativePromotion({ entryId: 'e1', source: 'src', reason: 'r' }, { dataDir });
    const b = recordNegativePromotion({ entryId: 'e2', source: 'src', reason: 'r' }, { dataDir });
    expect(b.sequence).toBe(2);
    expect(b.previousHash).toBe(a.entryHash);
  });

  test('throws on missing entryId or reason', () => {
    expect(() => recordNegativePromotion({ source: 's', reason: 'r' }, { dataDir })).toThrow();
    expect(() => recordNegativePromotion({ entryId: 'e', source: 's' }, { dataDir })).toThrow();
  });

  test('summarizePenalty: 0 events → cumulativePenalty 1.0', () => {
    const r = summarizePenalty('never-recorded', { dataDir });
    expect(r.totalEvents).toBe(0);
    expect(r.cumulativePenalty).toBe(1);
  });

  test('summarizePenalty: single recent event applies factor', () => {
    recordNegativePromotion({ entryId: 'e1', source: 's', reason: 'r' }, { dataDir });
    const r = summarizePenalty('e1', { dataDir });
    expect(r.totalEvents).toBe(1);
    // Recent event: weight ≈ 1, cumulative ≈ 0.95
    expect(r.cumulativePenalty).toBeLessThan(1);
    expect(r.cumulativePenalty).toBeGreaterThan(0.94);
  });

  test('multiple events compound', () => {
    for (let i = 0; i < 5; i++) {
      recordNegativePromotion({ entryId: 'e1', source: 's', reason: 'r' + i }, { dataDir });
    }
    const r = summarizePenalty('e1', { dataDir });
    expect(r.totalEvents).toBe(5);
    // 0.95^5 ≈ 0.7738 (recent events, weight ~1)
    expect(r.cumulativePenalty).toBeLessThan(0.78);
    expect(r.cumulativePenalty).toBeGreaterThan(0.77);
  });

  test('old events count less (decay half-life applied)', () => {
    // Old event: occurredAt 28 days ago, halfLife 14d → weight ≈ 0.25
    const oldDate = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
    recordNegativePromotion({ entryId: 'e1', source: 's', reason: 'r' }, { dataDir, occurredAt: oldDate });
    const r = summarizePenalty('e1', { dataDir });
    // factor = 1 - 0.05 * 0.25 = 0.9875
    expect(r.cumulativePenalty).toBeGreaterThan(0.98);
  });

  test('applyToConfidence multiplies but respects floor', () => {
    for (let i = 0; i < 100; i++) {
      recordNegativePromotion({ entryId: 'e1', source: 's', reason: 'r' + i }, { dataDir });
    }
    const r = applyToConfidence(1, 'e1', { dataDir, floor: 0.10 });
    expect(r).toBe(0.10);
  });

  test('applyToConfidence with no events returns base unchanged', () => {
    const r = applyToConfidence(0.7, 'never', { dataDir });
    expect(r).toBeCloseTo(0.7, 6);
  });

  test('listEvents filters by entryId', () => {
    recordNegativePromotion({ entryId: 'a', source: 's', reason: 'r' }, { dataDir });
    recordNegativePromotion({ entryId: 'b', source: 's', reason: 'r' }, { dataDir });
    recordNegativePromotion({ entryId: 'a', source: 's', reason: 'r' }, { dataDir });
    expect(listEvents({ dataDir }).length).toBe(3);
    expect(listEvents({ dataDir, entryId: 'a' }).length).toBe(2);
    expect(listEvents({ dataDir, entryId: 'b' }).length).toBe(1);
  });

  test('verifyLedger detects tampering', () => {
    recordNegativePromotion({ entryId: 'e', source: 's', reason: 'r' }, { dataDir });
    recordNegativePromotion({ entryId: 'e', source: 's', reason: 'r' }, { dataDir });
    const filePath = path.join(dataDir, 'security', 'negative-promotion-ledger.jsonl');
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[0]);
    tampered.reason = 'forged-reason';
    lines[0] = JSON.stringify(tampered);
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
    const r = verifyLedger({ dataDir });
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe(1);
  });

  test('verifyLedger passes on untampered ledger', () => {
    recordNegativePromotion({ entryId: 'e', source: 's', reason: 'r' }, { dataDir });
    const r = verifyLedger({ dataDir });
    expect(r.ok).toBe(true);
    expect(r.entries).toBe(1);
  });
});
