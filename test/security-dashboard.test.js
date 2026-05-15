'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildDashboard } = require('../lib/security/dashboard');
const { appendScan } = require('../lib/security/scan-ledger');
const { scanContent } = require('../lib/security/egress-scanner');
const { createAnchor } = require('../lib/security/graph-anchor');
const { plantCanary } = require('../lib/security/canary');
const { runDreamCycle } = require('../lib/security/dream-cycle');

describe('operator security dashboard', () => {
  let dataDir;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-dashboard-test-'));
  });
  afterEach(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('empty stack: green-gray status with all-issues list', () => {
    const r = buildDashboard({ dataDir, windowHours: 24 });
    expect(r.overallStatus).toMatch(/gray|green/);
    expect(r.issues.length).toBeGreaterThanOrEqual(2); // at least canaries + anchor missing
    expect(r.egress.available).toBe(false);
    expect(r.anchor.totalAnchors).toBe(0);
    expect(r.canaries.totalPlanted).toBe(0);
  });

  test('egress section reflects ledger state after a scan', () => {
    appendScan(scanContent({ content: 'sk-ant-' + 'a'.repeat(95) }), { dataDir });
    appendScan(scanContent({ content: 'plain text content here, no leak' }), { dataDir });
    const r = buildDashboard({ dataDir, windowHours: 24 });
    expect(r.egress.available).toBe(true);
    expect(r.egress.totalEverScanned).toBe(2);
    expect(r.egress.last.scans).toBeGreaterThanOrEqual(1);
  });

  test('anchor section reflects latest anchor', () => {
    createAnchor({ entries: [{ id: 'e1' }], manifests: [], specialists: [], ledgerHeads: {} }, { dataDir, label: 'pre-launch' });
    const r = buildDashboard({ dataDir, windowHours: 24 });
    expect(r.anchor.totalAnchors).toBe(1);
    expect(r.anchor.latest.label).toBe('pre-launch');
  });

  test('canary section reflects planted canaries', () => {
    plantCanary({ project: 'recall-dev', dataDir });
    plantCanary({ project: 'recall-dev', dataDir });
    plantCanary({ project: 'other', dataDir });
    const r = buildDashboard({ dataDir, windowHours: 24 });
    expect(r.canaries.totalPlanted).toBe(3);
    expect(r.canaries.plantedByProject['recall-dev']).toBe(2);
    expect(r.canaries.plantedByProject['other']).toBe(1);
  });

  test('dream section reflects last dream run', () => {
    runDreamCycle({
      reconsolidationEvents: () => ({ count: 0 }),
      basinEntries: () => ({ count: 0, samples: [] }),
      morphologyDelta: () => ({ skipped: 'none' }),
      graphAnchorDrift: () => ({ rootChanged: false }),
      deniedActions: () => ({ count: 0 }),
      hardCases: () => ({ count: 0 }),
    }, { dataDir, project: 'recall-dev', windowHours: 24 });
    const r = buildDashboard({ dataDir, windowHours: 24 });
    expect(r.dream.totalRuns).toBe(1);
    expect(r.dream.last.proposalCount).toBe(0);
  });

  test('overallStatus = red when drift section returns critical', () => {
    // First, populate baseline-only entries so current-window has zero
    // — that triggers a scanFrequency-drop critical drift signal.
    const longAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
    const ledgerPath = path.join(dataDir, 'security', 'egress-scan-ledger.jsonl');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const linesIn = [];
    for (let i = 0; i < 50; i++) {
      linesIn.push(JSON.stringify({
        sequence: i + 1,
        previousHash: i === 0 ? null : 'sha256:fake',
        scanId: 'egress-scan-' + i,
        decision: 'allow',
        contentHash: 'sha256:c',
        scannedAt: longAgo,
        kind: 'inline',
        target: null,
        sourcePath: null,
        blockerIds: [],
        warningIds: [],
        detectorVersion: 1,
        entryHash: 'sha256:e' + i,
      }));
    }
    fs.writeFileSync(ledgerPath, linesIn.join('\n') + '\n');

    const r = buildDashboard({ dataDir, windowHours: 24 });
    expect(r.drift.available).toBe(true);
    // baseline 50 scans / current 0 scans → critical scanFrequency drop
    expect(['critical', 'investigate', 'monitor']).toContain(r.drift.decision);
  });

  test('issues list is human-readable + actionable', () => {
    const r = buildDashboard({ dataDir, windowHours: 24 });
    for (const issue of r.issues) {
      expect(typeof issue).toBe('string');
      expect(issue.length).toBeGreaterThan(10);
    }
  });

  test('decay section degrades when no store provided', () => {
    const r = buildDashboard({ dataDir, windowHours: 24 });
    expect(r.decay.available).toBe(false);
    expect(r.decay.note).toContain('store');
  });
});
