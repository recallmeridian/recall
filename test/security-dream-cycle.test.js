'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { runDreamCycle, listDreamRuns, verifyDreamLedger } = require('../lib/security/dream-cycle');

function silentCollectors(overrides = {}) {
  return {
    reconsolidationEvents: () => ({ count: 0 }),
    basinEntries: () => ({ count: 0, samples: [] }),
    morphologyDelta: () => ({ skipped: 'none' }),
    graphAnchorDrift: () => ({ rootChanged: false }),
    deniedActions: () => ({ count: 0 }),
    hardCases: () => ({ count: 0 }),
    ...overrides,
  };
}

describe('dream cycle', () => {
  let dataDir;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-cycle-test-'));
  });
  afterEach(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('quiet night: no proposals + ledger entry recorded', () => {
    const r = runDreamCycle(silentCollectors(), { dataDir, project: 'recall-dev', windowHours: 24 });
    expect(r.proposals).toHaveLength(0);
    expect(r.ledgerEntry).toBeTruthy();
    expect(r.ledgerEntry.sequence).toBe(1);
    expect(r.ledgerEntry.previousHash).toBeNull();
    expect(r.ledgerEntry.proposalCount).toBe(0);
  });

  test('reconsolidation activity → terrain-cleanup proposal', () => {
    const r = runDreamCycle(silentCollectors({
      reconsolidationEvents: () => ({ count: 12 }),
    }), { dataDir });
    expect(r.proposals.find((p) => p.kind === 'terrain-cleanup')).toBeTruthy();
    expect(r.proposals[0].requiresHumanReview).toBe(true);
    expect(r.proposals[0].suggestedDecision).toBe('review');
  });

  test('basin growth → promote-candidate proposal', () => {
    const r = runDreamCycle(silentCollectors({
      basinEntries: () => ({ count: 5, samples: ['a', 'b', 'c'] }),
    }), { dataDir });
    expect(r.proposals.find((p) => p.kind === 'promote-candidate')).toBeTruthy();
    expect(r.proposals[0].evidenceRefs).toEqual(['a', 'b', 'c']);
  });

  test('graph anchor drift → investigate-anomaly proposal', () => {
    const r = runDreamCycle(silentCollectors({
      graphAnchorDrift: () => ({ rootChanged: true, subRootsChanged: ['entries', 'manifests'], anchorId: 'anchor-xyz' }),
    }), { dataDir });
    const proposal = r.proposals.find((p) => p.kind === 'investigate-anomaly');
    expect(proposal).toBeTruthy();
    expect(proposal.summary).toContain('entries');
    expect(proposal.evidenceRefs).toContain('anchor-xyz');
  });

  test('denied egress → tighten-policy proposal', () => {
    const r = runDreamCycle(silentCollectors({
      deniedActions: () => ({ count: 8 }),
    }), { dataDir });
    expect(r.proposals.find((p) => p.kind === 'tighten-policy')).toBeTruthy();
  });

  test('hard cases → promote-candidate proposal', () => {
    const r = runDreamCycle(silentCollectors({
      hardCases: () => ({ count: 7 }),
    }), { dataDir });
    expect(r.proposals.find((p) => p.kind === 'promote-candidate')).toBeTruthy();
  });

  test('all surveyors firing → multiple proposals, all requireHumanReview', () => {
    const r = runDreamCycle(silentCollectors({
      reconsolidationEvents: () => ({ count: 10 }),
      basinEntries: () => ({ count: 4, samples: [] }),
      graphAnchorDrift: () => ({ rootChanged: true, subRootsChanged: ['entries'] }),
      deniedActions: () => ({ count: 5 }),
      hardCases: () => ({ count: 6 }),
    }), { dataDir });
    expect(r.proposals.length).toBeGreaterThanOrEqual(4);
    for (const p of r.proposals) {
      expect(p.requiresHumanReview).toBe(true);
      expect(['review', 'allow']).toContain(p.suggestedDecision);
      // Kernel invariant: proposals never carry an unbounded auto-promote
      expect(p.suggestedDecision).not.toBe('promote');
    }
  });

  test('hash-chain links sequential dream runs', () => {
    const a = runDreamCycle(silentCollectors(), { dataDir });
    const b = runDreamCycle(silentCollectors({ reconsolidationEvents: () => ({ count: 6 }) }), { dataDir });
    expect(b.ledgerEntry.sequence).toBe(2);
    expect(b.ledgerEntry.previousHash).toBe(a.ledgerEntry.entryHash);
  });

  test('listDreamRuns returns all entries', () => {
    runDreamCycle(silentCollectors(), { dataDir });
    runDreamCycle(silentCollectors(), { dataDir });
    runDreamCycle(silentCollectors(), { dataDir });
    expect(listDreamRuns({ dataDir })).toHaveLength(3);
  });

  test('verifyDreamLedger detects tampering', () => {
    runDreamCycle(silentCollectors(), { dataDir });
    runDreamCycle(silentCollectors(), { dataDir });
    const filePath = path.join(dataDir, 'security', 'dream-cycle-ledger.jsonl');
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[0]);
    tampered.proposalCount = 999;
    lines[0] = JSON.stringify(tampered);
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
    const r = verifyDreamLedger({ dataDir });
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe(1);
  });

  test('survey errors are caught and recorded, not thrown', () => {
    const r = runDreamCycle({
      reconsolidationEvents: () => { throw new Error('boom'); },
    }, { dataDir });
    expect(r.surveys.reconsolidationEvents.error).toBe('boom');
    expect(r.proposals).toBeDefined();
  });

  test('appendToLedger=false skips ledger write', () => {
    const r = runDreamCycle(silentCollectors(), { dataDir, appendToLedger: false });
    expect(r.ledgerEntry).toBeNull();
    expect(listDreamRuns({ dataDir })).toHaveLength(0);
  });
});
