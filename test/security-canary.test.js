'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const {
  plantCanary,
  listCanaries,
  verifyCanaryLedger,
  detectCanaryHits,
  markerToken,
} = require('../lib/security/canary');

describe('canary entries in ridge', () => {
  let dataDir;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-test-'));
  });
  afterEach(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('plantCanary writes a sequence-1 ledger entry with marker and content', () => {
    const r = plantCanary({ project: 'recall-dev', dataDir });
    expect(r.canaryId).toMatch(/^canary-/);
    expect(r.marker).toMatch(/^canary-marker-/);
    expect(r.entry.sequence).toBe(1);
    expect(r.entry.previousHash).toBeNull();
    expect(r.entry.entryHash).toMatch(/^sha256:/);
    expect(r.entry.suggestedKbEntry.tags).toContain('canary');
    expect(r.entry.suggestedKbEntry.tags).toContain('do-not-surface');
    expect(r.entry.suggestedKbEntry.description).toContain(r.marker);
  });

  test('marker is deterministic given the same canary id and key', () => {
    const key = crypto.randomBytes(32);
    const a = markerToken('canary-abc123', key);
    const b = markerToken('canary-abc123', key);
    expect(a).toBe(b);
    expect(a).toMatch(/^canary-marker-[0-9a-f]{24}$/);
  });

  test('marker differs across canary ids', () => {
    const key = crypto.randomBytes(32);
    const a = markerToken('canary-a', key);
    const b = markerToken('canary-b', key);
    expect(a).not.toBe(b);
  });

  test('two consecutive canaries hash-chain via previousHash', () => {
    const a = plantCanary({ project: 'recall-dev', dataDir });
    const b = plantCanary({ project: 'recall-dev', dataDir });
    expect(b.entry.sequence).toBe(2);
    expect(b.entry.previousHash).toBe(a.entry.entryHash);
  });

  test('listCanaries filters by project', () => {
    plantCanary({ project: 'recall-dev', dataDir });
    plantCanary({ project: 'recall-dev', dataDir });
    plantCanary({ project: 'other-proj', dataDir });
    expect(listCanaries({ dataDir }).length).toBe(3);
    expect(listCanaries({ dataDir, project: 'recall-dev' }).length).toBe(2);
    expect(listCanaries({ dataDir, project: 'other-proj' }).length).toBe(1);
  });

  test('verifyCanaryLedger passes on untampered chain', () => {
    plantCanary({ project: 'recall-dev', dataDir });
    plantCanary({ project: 'recall-dev', dataDir });
    const r = verifyCanaryLedger({ dataDir });
    expect(r.ok).toBe(true);
    expect(r.entries).toBe(2);
  });

  test('verifyCanaryLedger detects entry tampering', () => {
    plantCanary({ project: 'recall-dev', dataDir });
    plantCanary({ project: 'recall-dev', dataDir });
    const filePath = path.join(dataDir, 'security', 'canary-ledger.jsonl');
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[0]);
    tampered.marker = 'canary-marker-FORGED' + 'x'.repeat(20);
    lines[0] = JSON.stringify(tampered);
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
    const r = verifyCanaryLedger({ dataDir });
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe(1);
  });

  test('detectCanaryHits finds embedded markers in content', () => {
    const planted = plantCanary({ project: 'recall-dev', dataDir });
    const malicious = `here is some leaked text including ${planted.marker} and other stuff`;
    const hits = detectCanaryHits({ content: malicious, source: 'specialist-output', dataDir });
    expect(hits.length).toBe(1);
    expect(hits[0].canaryId).toBe(planted.canaryId);
    expect(hits[0].source).toBe('specialist-output');
    expect(hits[0].firstOffset).toBeGreaterThan(0);
  });

  test('detectCanaryHits returns empty for clean content', () => {
    plantCanary({ project: 'recall-dev', dataDir });
    const hits = detectCanaryHits({ content: 'no canary markers here', dataDir });
    expect(hits).toEqual([]);
  });

  test('detectCanaryHits flags multiple canaries when multiple markers appear', () => {
    const a = plantCanary({ project: 'recall-dev', dataDir });
    const b = plantCanary({ project: 'recall-dev', dataDir });
    const content = `pre ${a.marker} mid ${b.marker} post`;
    const hits = detectCanaryHits({ content, dataDir });
    expect(hits.length).toBe(2);
    const ids = hits.map((h) => h.canaryId).sort();
    expect(ids).toEqual([a.canaryId, b.canaryId].sort());
  });

  test('label is round-tripped on the canary entry', () => {
    const r = plantCanary({ project: 'recall-dev', dataDir, label: 'pre-launch sentinel' });
    expect(r.entry.label).toBe('pre-launch sentinel');
  });

  test('content includes do-not-surface warning', () => {
    const r = plantCanary({ project: 'recall-dev', dataDir });
    expect(r.entry.suggestedKbEntry.description).toContain('do not surface');
    expect(r.entry.suggestedKbEntry.description).toContain('alarm');
  });
});
