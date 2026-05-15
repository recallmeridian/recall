'use strict';

const { evaluateBridgeDegrees, suggestPruning } = require('../lib/security/bridge-degree');

const REL = (from, to, extra = {}) => ({ from, to, project: 'recall-dev', createdAt: '2026-05-12T00:00:00Z', confidence: 0.5, ...extra });

describe('bridge-degree caps (failure mode #7b)', () => {
  test('empty graph → allow', () => {
    const r = evaluateBridgeDegrees({ relations: [], capPerNode: 5 });
    expect(r.decision).toBe('allow');
    expect(r.exceedances).toEqual([]);
    expect(r.summary.totalNodes).toBe(0);
  });

  test('all nodes within cap → allow', () => {
    const rels = [REL('a', 'b'), REL('b', 'c'), REL('c', 'd')];
    const r = evaluateBridgeDegrees({ relations: rels, capPerNode: 5 });
    expect(r.decision).toBe('allow');
    expect(r.summary.maxDegree).toBe(2);
  });

  test('one node exceeds cap → requires_pruning', () => {
    const hub = 'hub';
    const rels = [];
    for (let i = 0; i < 10; i++) rels.push(REL(hub, 'leaf' + i));
    const r = evaluateBridgeDegrees({ relations: rels, capPerNode: 5 });
    expect(r.decision).toBe('requires_pruning');
    const exceed = r.exceedances.find((e) => e.nodeId === hub);
    expect(exceed.degree).toBe(10);
    expect(exceed.excess).toBe(5);
  });

  test('node exceeds 2x cap → block (gross concentration)', () => {
    const hub = 'mega-hub';
    const rels = [];
    for (let i = 0; i < 25; i++) rels.push(REL(hub, 'leaf' + i));
    const r = evaluateBridgeDegrees({ relations: rels, capPerNode: 10, blockMultiplier: 2 });
    expect(r.decision).toBe('block');
  });

  test('symmetric counting: a-b adds 1 to both a and b', () => {
    const rels = [REL('a', 'b')];
    const r = evaluateBridgeDegrees({ relations: rels, capPerNode: 100 });
    expect(r.summary.maxDegree).toBe(1);
    expect(r.summary.totalNodes).toBe(2);
  });

  test('per-project cap fires when set', () => {
    const rels = [];
    for (let i = 0; i < 12; i++) rels.push(REL('a' + i, 'b' + i, { project: 'p1' }));
    const r = evaluateBridgeDegrees({ relations: rels, capPerNode: 100, capPerProject: 10 });
    expect(r.perProjectExceedances).toHaveLength(1);
    expect(r.perProjectExceedances[0].project).toBe('p1');
    expect(r.perProjectExceedances[0].count).toBe(12);
  });
});

describe('bridge-degree pruning suggestions', () => {
  test('oldest-first strategy retires oldest edges to reach cap', () => {
    const hub = 'hub';
    const edges = [];
    for (let i = 0; i < 8; i++) {
      edges.push({ from: hub, to: 'l' + i, createdAt: `2026-05-${String(i + 1).padStart(2, '0')}T00:00:00Z`, confidence: 0.5 });
    }
    const exceedances = [{ nodeId: hub, degree: 8, cap: 5, excess: 3, edges }];
    const proposals = suggestPruning({ exceedances, strategy: 'oldest-first' });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].edgesToRetire).toHaveLength(3);
    expect(proposals[0].edgesToRetire[0].to).toBe('l0'); // oldest
    expect(proposals[0].edgesToRetire[1].to).toBe('l1');
    expect(proposals[0].edgesToRetire[2].to).toBe('l2');
    expect(proposals[0].retainedDegree).toBe(5);
  });

  test('lowest-confidence strategy retires least-trusted edges first', () => {
    const hub = 'hub';
    const edges = [
      { from: hub, to: 'a', confidence: 0.9 },
      { from: hub, to: 'b', confidence: 0.1 },
      { from: hub, to: 'c', confidence: 0.5 },
      { from: hub, to: 'd', confidence: 0.3 },
    ];
    const exceedances = [{ nodeId: hub, degree: 4, cap: 2, excess: 2, edges }];
    const proposals = suggestPruning({ exceedances, strategy: 'lowest-confidence' });
    const retiredTo = proposals[0].edgesToRetire.map((e) => e.to);
    expect(retiredTo).toEqual(['b', 'd']); // 0.1, 0.3
  });

  test('unknown strategy throws', () => {
    expect(() => suggestPruning({ exceedances: [{ nodeId: 'a', degree: 3, cap: 1, excess: 2, edges: [] }], strategy: 'cosmic-ray' })).toThrow();
  });

  test('no exceedances → no proposals', () => {
    expect(suggestPruning({ exceedances: [], strategy: 'oldest-first' })).toEqual([]);
  });
});
