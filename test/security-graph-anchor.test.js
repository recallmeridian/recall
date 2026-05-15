'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const {
  computeAnchorState,
  createAnchor,
  listAnchors,
  getAnchor,
  verifyLedgerChain,
  verifyAgainstAnchor,
  signAnchor,
} = require('../lib/security/graph-anchor');

const SAMPLE_INPUTS = {
  entries: [
    { id: 'decision-1', project: 'recall-dev', category: 'decisions', contentHash: 'sha256:aaa' },
    { id: 'lesson-2', project: 'recall-dev', category: 'lessons', contentHash: 'sha256:bbb' },
  ],
  manifests: [{ feature_id: 'feature-foo', manifestHash: 'sha256:m1' }],
  specialists: [{ id: 'openclaw-governor', version: 2, promptHash: 'sha256:p1' }],
  ledgerHeads: { 'egress-scan': 'sha256:abc', 'feature-runs': null },
};

describe('graph-anchor: pure compute', () => {
  test('computeAnchorState produces a sha256 root + sub-roots + counts', () => {
    const r = computeAnchorState(SAMPLE_INPUTS);
    expect(r.rootHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.subRoots.entries).toMatch(/^sha256:/);
    expect(r.subRoots.manifests).toMatch(/^sha256:/);
    expect(r.subRoots.specialists).toMatch(/^sha256:/);
    expect(r.subRoots.ledgerHeads).toMatch(/^sha256:/);
    expect(r.counts).toEqual({ entries: 2, manifests: 1, specialists: 1, ledgerHeads: 2 });
  });

  test('computeAnchorState is deterministic for the same inputs (any order)', () => {
    const a = computeAnchorState({
      entries: [SAMPLE_INPUTS.entries[1], SAMPLE_INPUTS.entries[0]],
      manifests: SAMPLE_INPUTS.manifests,
      specialists: SAMPLE_INPUTS.specialists,
      ledgerHeads: { 'feature-runs': null, 'egress-scan': 'sha256:abc' },
    });
    const b = computeAnchorState(SAMPLE_INPUTS);
    expect(a.rootHash).toBe(b.rootHash);
  });

  test('computeAnchorState changes root when any input changes', () => {
    const a = computeAnchorState(SAMPLE_INPUTS);
    const b = computeAnchorState({ ...SAMPLE_INPUTS, entries: [...SAMPLE_INPUTS.entries, { id: 'new', project: 'x', category: 'y', contentHash: 'sha256:zzz' }] });
    expect(a.rootHash).not.toBe(b.rootHash);
    expect(a.subRoots.entries).not.toBe(b.subRoots.entries);
    expect(a.subRoots.manifests).toBe(b.subRoots.manifests);
  });

  test('signAnchor with a fixed key is deterministic', () => {
    const key = crypto.randomBytes(32);
    const a = signAnchor('sha256:foo', { key });
    const b = signAnchor('sha256:foo', { key });
    expect(a).toBe(b);
    expect(a).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
  });

  test('signAnchor changes when key changes', () => {
    const a = signAnchor('sha256:foo', { key: crypto.randomBytes(32) });
    const b = signAnchor('sha256:foo', { key: crypto.randomBytes(32) });
    expect(a).not.toBe(b);
  });
});

describe('graph-anchor: ledger', () => {
  let dataDir;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-anchor-test-'));
  });
  afterEach(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('createAnchor writes a sequence-1 entry with no previousHash', () => {
    const r = createAnchor(SAMPLE_INPUTS, { dataDir });
    expect(r.entry.sequence).toBe(1);
    expect(r.entry.previousHash).toBeNull();
    expect(r.entry.rootHash).toMatch(/^sha256:/);
    expect(r.entry.signature).toMatch(/^hmac-sha256:/);
    expect(r.entry.entryHash).toMatch(/^sha256:/);
    expect(r.entry.anchorId).toMatch(/^anchor-/);
    expect(r.driftSummary).toBeNull();
  });

  test('second createAnchor links to first via previousHash + emits drift summary', () => {
    const a = createAnchor(SAMPLE_INPUTS, { dataDir });
    const b = createAnchor({
      ...SAMPLE_INPUTS,
      entries: [...SAMPLE_INPUTS.entries, { id: 'new', project: 'x', category: 'y', contentHash: 'sha256:zzz' }],
    }, { dataDir });
    expect(b.entry.sequence).toBe(2);
    expect(b.entry.previousHash).toBe(a.entry.entryHash);
    expect(b.driftSummary).toBeTruthy();
    expect(b.driftSummary.rootChanged).toBe(true);
    expect(b.driftSummary.subRootsChanged).toContain('entries');
    expect(b.driftSummary.countDeltas.entries).toBe(1);
  });

  test('listAnchors returns all anchors in order', () => {
    createAnchor(SAMPLE_INPUTS, { dataDir });
    createAnchor({ ...SAMPLE_INPUTS, manifests: [{ feature_id: 'feature-bar', manifestHash: 'sha256:m2' }] }, { dataDir });
    const list = listAnchors({ dataDir });
    expect(list).toHaveLength(2);
    expect(list[0].sequence).toBe(1);
    expect(list[1].sequence).toBe(2);
  });

  test('getAnchor finds by id', () => {
    const r = createAnchor(SAMPLE_INPUTS, { dataDir });
    const found = getAnchor(r.entry.anchorId, { dataDir });
    expect(found).toBeTruthy();
    expect(found.anchorId).toBe(r.entry.anchorId);
  });

  test('verifyLedgerChain passes on untampered ledger', () => {
    createAnchor(SAMPLE_INPUTS, { dataDir });
    createAnchor({ ...SAMPLE_INPUTS, manifests: [{ feature_id: 'feature-bar', manifestHash: 'sha256:m2' }] }, { dataDir });
    const r = verifyLedgerChain({ dataDir });
    expect(r.ok).toBe(true);
    expect(r.entries).toBe(2);
  });

  test('verifyLedgerChain detects ledger tampering', () => {
    createAnchor(SAMPLE_INPUTS, { dataDir });
    createAnchor({ ...SAMPLE_INPUTS, entries: [...SAMPLE_INPUTS.entries, { id: 'extra', project: 'x', category: 'y', contentHash: 'sha256:e' }] }, { dataDir });
    const ledgerPath = path.join(dataDir, 'security', 'graph-anchor-ledger.jsonl');
    const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[0]);
    tampered.rootHash = 'sha256:00000000000000000000000000000000'; // forge root
    lines[0] = JSON.stringify(tampered);
    fs.writeFileSync(ledgerPath, lines.join('\n') + '\n');
    const r = verifyLedgerChain({ dataDir });
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe(1);
  });

  test('verifyAgainstAnchor passes when current state matches', () => {
    const created = createAnchor(SAMPLE_INPUTS, { dataDir });
    const r = verifyAgainstAnchor(SAMPLE_INPUTS, created.entry.anchorId, { dataDir });
    expect(r.ok).toBe(true);
    expect(r.signatureValid).toBe(true);
    expect(r.drift.rootChanged).toBe(false);
  });

  test('verifyAgainstAnchor reports drift when state has changed', () => {
    const created = createAnchor(SAMPLE_INPUTS, { dataDir });
    const drifted = {
      ...SAMPLE_INPUTS,
      entries: [...SAMPLE_INPUTS.entries, { id: 'newone', project: 'recall-dev', category: 'decisions', contentHash: 'sha256:new' }],
    };
    const r = verifyAgainstAnchor(drifted, created.entry.anchorId, { dataDir });
    expect(r.ok).toBe(false);
    expect(r.signatureValid).toBe(true); // anchor still legit, just doesn't match current
    expect(r.drift.rootChanged).toBe(true);
    expect(r.drift.subRootsChanged).toContain('entries');
    expect(r.drift.countDeltas.entries).toBe(1);
  });

  test('verifyAgainstAnchor returns anchor_not_found for unknown id', () => {
    const r = verifyAgainstAnchor(SAMPLE_INPUTS, 'anchor-doesnotexist', { dataDir });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('anchor_not_found');
  });

  test('label is round-tripped', () => {
    const r = createAnchor(SAMPLE_INPUTS, { dataDir, label: 'pre-publish 0.3.0' });
    expect(r.entry.label).toBe('pre-publish 0.3.0');
    const found = getAnchor(r.entry.anchorId, { dataDir });
    expect(found.label).toBe('pre-publish 0.3.0');
  });
});
