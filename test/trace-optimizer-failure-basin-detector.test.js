'use strict';

const { detectBasins, normalizeSignal, slugify } = require('../lib/trace-optimizer/failure-basin-detector');

describe('failure-basin-detector', () => {
  test('normalizeSignal lowercases, collapses whitespace, strips quotes', () => {
    expect(normalizeSignal('  Tool   "failed"  with EPERM ')).toBe('tool failed with eperm');
  });

  test('normalizeSignal extracts text from structured { signal, detail } objects', () => {
    expect(normalizeSignal({ signal: 'sandbox_eperm', detail: 'spawn blocked' }))
      .toBe('sandbox_eperm: spawn blocked');
    expect(normalizeSignal({ signal: 'sandbox_eperm' })).toBe('sandbox_eperm');
    expect(normalizeSignal({ summary: 'something broke' })).toBe('something broke');
    expect(normalizeSignal({ message: 'fail', reason: 'because' })).toBe('fail: because');
  });

  test('normalizeSignal NEVER returns "[object object]" for object inputs', () => {
    const cases = [
      { signal: 'a', detail: 'b' },
      { summary: 'x' },
      { message: 'm' },
      { code: 'c' },
      { title: 't' },
      { type: 'ty' },
      { unknown: 'shape', other: 'fields' }, // falls through to JSON.stringify
    ];
    for (const c of cases) {
      const out = normalizeSignal(c);
      expect(out).not.toBe('[object object]');
      expect(out.length).toBeGreaterThan(0);
    }
  });

  test('slugify produces safe id fragments', () => {
    expect(slugify('Tool failed: EPERM on /tmp')).toBe('tool-failed-eperm-on-tmp');
    expect(slugify('')).toBe('basin');
  });

  test('detectBasins clusters by normalized failure signal and respects minCount', () => {
    const cases = [
      { handoffId: 'h1', agentId: 'impl', taskType: 'implementation', project: 'recall-dev', failureSignal: 'Sandbox EPERM' },
      { handoffId: 'h2', agentId: 'impl', taskType: 'implementation', project: 'recall-dev', failureSignal: 'sandbox  eperm' },
      { handoffId: 'h3', agentId: 'review', taskType: 'review', project: 'recall-dev', failureSignal: 'Sandbox EPERM' },
      { handoffId: 'h4', agentId: 'impl', taskType: 'implementation', project: 'polymarket', failureSignal: 'Test not run' },
      { handoffId: 'h5', agentId: 'impl', taskType: 'implementation', project: 'polymarket', failureSignal: 'Test not run' },
    ];

    const basinsMin3 = detectBasins(cases, { minCount: 3 });
    expect(basinsMin3).toHaveLength(1);
    const eperm = basinsMin3[0];
    expect(eperm.pattern).toBe('sandbox eperm');
    expect(eperm.count).toBe(3);
    expect(eperm.sampleHandoffIds.slice().sort()).toEqual(['h1', 'h2', 'h3']);
    expect(eperm.agents).toEqual(['impl', 'review']);
    expect(eperm.taskTypes).toEqual(['implementation', 'review']);
    expect(eperm.projects).toEqual(['recall-dev']);
    expect(eperm.entryType).toBe('failure_basin');
    expect(eperm.status).toBe('detected');
    expect(eperm.promotionStatus).toBe('pending_reflection');
    expect(eperm.reflection).toBeNull();
    expect(eperm.recommendation).toBeNull();

    const basinsMin2 = detectBasins(cases, { minCount: 2 });
    expect(basinsMin2).toHaveLength(2);
    const counts = basinsMin2.map((basin) => basin.count).sort((a, b) => b - a);
    expect(counts).toEqual([3, 2]);
  });

  test('detectBasins sorts by count desc and caps samples at sampleLimit', () => {
    const cases = [];
    for (let i = 0; i < 12; i += 1) {
      cases.push({ handoffId: `b-${i}`, agentId: 'impl', taskType: 'implementation', project: 'recall-dev', failureSignal: 'big basin' });
    }
    for (let i = 0; i < 4; i += 1) {
      cases.push({ handoffId: `s-${i}`, agentId: 'impl', taskType: 'implementation', project: 'recall-dev', failureSignal: 'small basin' });
    }
    const basins = detectBasins(cases, { minCount: 3, sampleLimit: 5 });
    expect(basins).toHaveLength(2);
    expect(basins[0].pattern).toBe('big basin');
    expect(basins[0].count).toBe(12);
    expect(basins[0].sampleHandoffIds).toHaveLength(5);
    expect(basins[0].rawSamples).toHaveLength(5);
  });

  test('detectBasins ignores empty/missing signals', () => {
    const cases = [
      { handoffId: 'h1', agentId: 'impl', failureSignal: '' },
      { handoffId: 'h2', agentId: 'impl', failureSignal: '   ' },
      { handoffId: 'h3', agentId: 'impl' },
      { handoffId: 'h4', agentId: 'impl', failureSignal: 'real signal' },
      { handoffId: 'h5', agentId: 'impl', failureSignal: 'real signal' },
      { handoffId: 'h6', agentId: 'impl', failureSignal: 'real signal' },
    ];
    const basins = detectBasins(cases, { minCount: 3 });
    expect(basins).toHaveLength(1);
    expect(basins[0].pattern).toBe('real signal');
    expect(basins[0].count).toBe(3);
  });

  test('detectBasins handles empty input', () => {
    expect(detectBasins([], { minCount: 3 })).toEqual([]);
    expect(detectBasins(null, { minCount: 3 })).toEqual([]);
    expect(detectBasins(undefined, { minCount: 3 })).toEqual([]);
  });
});
