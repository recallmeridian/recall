'use strict';

const { detectCollusion } = require('../lib/security/collusion-detector');
const { scanContent } = require('../lib/security/egress-scanner');

const NOW = Date.now();
const ts = (offsetSec) => new Date(NOW - offsetSec * 1000).toISOString();

describe('multi-agent collusion detector', () => {
  test('empty records → no findings', () => {
    const r = detectCollusion({ records: [], windowHours: 24 });
    expect(r.findings).toHaveLength(0);
    expect(r.summary.totalAgents).toBe(0);
  });

  test('single-agent activity → no findings', () => {
    const records = [];
    for (let i = 0; i < 10; i++) {
      records.push({ recordId: 'r' + i, agentId: 'a1', actionKind: 'post', target: { text: 'hi' }, timestamp: ts(i * 60) });
    }
    const r = detectCollusion({ records, scanContent });
    expect(r.findings.filter((f) => f.kind === 'split-leak')).toEqual([]);
  });

  test('SPLIT-LEAK: two agents posting fragments that join into a Windows path', () => {
    const records = [
      { recordId: 'a', agentId: 'agent-1', actionKind: 'post', target: { text: 'workspace at C:\\Users\\' }, timestamp: ts(60) },
      { recordId: 'b', agentId: 'agent-2', actionKind: 'post', target: { text: '__USER__\\Desktop\\private-project' }, timestamp: ts(30) },
    ];
    const r = detectCollusion({ records, scanContent, windowHours: 24 });
    const sp = r.findings.find((f) => f.kind === 'split-leak');
    expect(sp).toBeTruthy();
    expect(sp.severity).toBe('high');
    expect(sp.agentIds.sort()).toEqual(['agent-1', 'agent-2']);
  });

  test('RATE-AGGREGATION: many agents each below limit but aggregate exceeds cap', () => {
    const records = [];
    for (let i = 0; i < 80; i++) {
      records.push({
        recordId: 'r' + i,
        agentId: 'agent-' + (i % 8), // 8 different agents
        actionKind: 'post',
        target: {},
        timestamp: ts(i * 60), // 1/min over 80 minutes ≈ 60/hour
      });
    }
    const r = detectCollusion({ records, ratePerHourCap: 30 });
    expect(r.findings.find((f) => f.kind === 'rate-aggregation')).toBeTruthy();
  });

  test('INFORMATION-AGGREGATION: many distinct agents each cite the same evidence id', () => {
    const records = [];
    for (let i = 0; i < 6; i++) {
      records.push({
        recordId: 'r' + i,
        agentId: 'agent-' + i,
        actionKind: 'read_kb',
        target: {},
        timestamp: ts(i * 600),
        evidence: ['decision-private-1234567890123'],
      });
    }
    const r = detectCollusion({ records, distinctRetrieverCap: 3 });
    const f = r.findings.find((x) => x.kind === 'information-aggregation');
    expect(f).toBeTruthy();
    expect(f.agentIds.length).toBe(6);
    expect(f.evidence).toContain('decision-private-1234567890123');
  });

  test('COORDINATED-TIMING: scripted cadence (intervals very close to identical)', () => {
    const records = [];
    for (let i = 0; i < 20; i++) {
      // Exactly 30 seconds apart
      records.push({
        recordId: 'r' + i,
        agentId: 'agent-' + (i % 3),
        actionKind: 'post',
        target: {},
        timestamp: new Date(NOW - i * 30 * 1000).toISOString(),
      });
    }
    const r = detectCollusion({ records, timingCvCap: 0.10 });
    expect(r.findings.find((f) => f.kind === 'coordinated-timing')).toBeTruthy();
  });

  test('organic timing variance is NOT flagged as coordinated', () => {
    const records = [];
    let cursor = 0;
    for (let i = 0; i < 10; i++) {
      cursor += 30 + Math.floor(Math.random() * 1000); // wide variance
      records.push({
        recordId: 'r' + i,
        agentId: 'agent-1',
        actionKind: 'post',
        target: {},
        timestamp: new Date(NOW - cursor * 1000).toISOString(),
      });
    }
    const r = detectCollusion({ records, timingCvCap: 0.10 });
    expect(r.findings.find((f) => f.kind === 'coordinated-timing')).toBeFalsy();
  });

  test('summary aggregates findings by kind', () => {
    const records = [];
    // Generate some rate-aggregation
    for (let i = 0; i < 60; i++) {
      records.push({ recordId: 'r' + i, agentId: 'agent-' + (i % 5), actionKind: 'post', target: {}, timestamp: ts(i * 30) });
    }
    // Plus an information-aggregation
    for (let i = 0; i < 5; i++) {
      records.push({ recordId: 'i' + i, agentId: 'reader-' + i, actionKind: 'read_kb', target: {}, timestamp: ts(i * 60), evidence: ['shared-evidence-id-1234567890'] });
    }
    const r = detectCollusion({ records, ratePerHourCap: 30, distinctRetrieverCap: 3 });
    expect(r.summary.byKind['rate-aggregation']).toBeGreaterThanOrEqual(1);
    expect(r.summary.byKind['information-aggregation']).toBeGreaterThanOrEqual(1);
    expect(r.summary.totalAgents).toBeGreaterThan(5);
  });

  test('windowHours filters out old records', () => {
    const records = [
      { recordId: 'old', agentId: 'a', actionKind: 'post', target: {}, timestamp: ts(48 * 3600) }, // 2 days ago
      { recordId: 'new', agentId: 'a', actionKind: 'post', target: {}, timestamp: ts(60) },
    ];
    const r = detectCollusion({ records, windowHours: 24 });
    expect(r.summary.totalRecords).toBe(1);
  });
});
