'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  queueItem,
  listItems,
  getItem,
  signItem,
  verifyQueueLedger,
  looksLikeLlmName,
} = require('../lib/security/architect-review-queue');

describe('architect-review-queue', () => {
  let dataDir;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archreview-test-'));
  });
  afterEach(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('queueItem writes a queued entry with computed dueAt', () => {
    const r = queueItem({
      title: 'Promote new live-write defense to production',
      surfaces: ['live-write', 'promotion-gate'],
      riskLevel: 'high',
      evidence: ['proposal-x', 'replay-y'],
      slaDays: 7,
    }, { dataDir });
    expect(r.itemId).toMatch(/^arch-review-/);
    expect(r.statusAfter).toBe('queued');
    expect(r.dueAt).toBeTruthy();
    expect(Date.parse(r.dueAt)).toBeGreaterThan(Date.parse(r.queuedAt));
  });

  test('throws on missing required fields', () => {
    expect(() => queueItem({ surfaces: ['x'], riskLevel: 'low' }, { dataDir })).toThrow(/title/);
    expect(() => queueItem({ title: 't', riskLevel: 'low' }, { dataDir })).toThrow(/surfaces/);
    expect(() => queueItem({ title: 't', surfaces: ['x'] }, { dataDir })).toThrow(/riskLevel/);
  });

  test('signItem requires humanName, decision, rationale', () => {
    const { itemId } = queueItem({ title: 't', surfaces: ['x'], riskLevel: 'high' }, { dataDir });
    expect(() => signItem(itemId, {}, { dataDir })).toThrow(/humanName/);
    expect(() => signItem(itemId, { humanName: 'Test User' }, { dataDir })).toThrow(/decision/);
    expect(() => signItem(itemId, { humanName: 'Test User', decision: 'approve' }, { dataDir })).toThrow(/rationale/);
  });

  test('signItem refuses LLM-shaped humanName', () => {
    const { itemId } = queueItem({ title: 't', surfaces: ['x'], riskLevel: 'high' }, { dataDir });
    for (const fakeName of ['claude-opus', 'GPT-5', 'Grok', 'gemini-2', 'codex', 'assistant', 'AI', 'anthropic-reviewer']) {
      expect(() => signItem(itemId, { humanName: fakeName, decision: 'approve', rationale: 'test' }, { dataDir }))
        .toThrow(/LLM identifier/);
    }
  });

  test('signItem accepts human names', () => {
    const { itemId } = queueItem({ title: 't', surfaces: ['x'], riskLevel: 'high' }, { dataDir });
    signItem(itemId, { humanName: 'Test User', decision: 'approve', rationale: 'reviewed offline' }, { dataDir });
    const item = getItem(itemId, { dataDir });
    expect(item.status).toBe('signed-approve');
    expect(item.humanName).toBe('Test User');
  });

  test('signItem rejects double-sign', () => {
    const { itemId } = queueItem({ title: 't', surfaces: ['x'], riskLevel: 'high' }, { dataDir });
    signItem(itemId, { humanName: 'Test User', decision: 'approve', rationale: 'r1' }, { dataDir });
    expect(() => signItem(itemId, { humanName: 'Test User', decision: 'reject', rationale: 'r2' }, { dataDir }))
      .toThrow(/already signed/);
  });

  test('overdue items get status=overdue', () => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    queueItem({ title: 'old', surfaces: ['x'], riskLevel: 'high', slaDays: 1 }, { dataDir, queuedAt: oldDate });
    const items = listItems({ dataDir });
    expect(items[0].status).toBe('overdue');
    const overdueOnly = listItems({ dataDir, overdue: true });
    expect(overdueOnly.length).toBe(1);
  });

  test('listItems filters by status', () => {
    queueItem({ title: 'a', surfaces: ['x'], riskLevel: 'high' }, { dataDir });
    const { itemId } = queueItem({ title: 'b', surfaces: ['x'], riskLevel: 'high' }, { dataDir });
    signItem(itemId, { humanName: 'Test User', decision: 'reject', rationale: 'no good' }, { dataDir });
    expect(listItems({ dataDir, status: 'queued' }).length).toBe(1);
    expect(listItems({ dataDir, status: 'signed-reject' }).length).toBe(1);
  });

  test('verifyQueueLedger detects tampering', () => {
    queueItem({ title: 'a', surfaces: ['x'], riskLevel: 'high' }, { dataDir });
    queueItem({ title: 'b', surfaces: ['x'], riskLevel: 'high' }, { dataDir });
    const filePath = path.join(dataDir, 'security', 'architect-review-ledger.jsonl');
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[0]);
    tampered.statusAfter = 'signed-approve';
    tampered.humanName = 'Forged Reviewer';
    lines[0] = JSON.stringify(tampered);
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
    const r = verifyQueueLedger({ dataDir });
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe(1);
  });

  test('looksLikeLlmName catches common patterns', () => {
    for (const n of ['claude-opus', 'GPT', 'grok', 'gemini', 'llama-3', 'o1', 'o3', 'assistant', 'AI', 'codex']) {
      expect(looksLikeLlmName(n)).toBe(true);
    }
    for (const n of ['Test User', 'Real Reviewer', 'Jane Doe', 'security@example.com']) {
      expect(looksLikeLlmName(n)).toBe(false);
    }
  });
});
