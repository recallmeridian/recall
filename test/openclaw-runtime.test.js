'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { processProposedAction } = require('../lib/openclaw/runtime');
const { listAuditRecords } = require('../lib/security/audit-ingest');

describe('OpenClaw runtime stub', () => {
  let dataDir;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-runtime-test-'));
  });
  afterEach(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('clean egress post → review (egress is always a review boundary)', async () => {
    const r = await processProposedAction({
      action: {
        actionKind: 'post',
        target: { channel: 'moltbook', text: 'Hello world from Recall Meridian.' },
        rationale: 'launch announcement',
      },
      dataDir,
    });
    expect(r.decision).toBe('review');
    expect(r.reason).toMatch(/egress/i);
    expect(r.dlpDecision).toBe('allow');
    expect(r.recordId).toMatch(/^audit-/);
  });

  test('post with a leaked API key → block', async () => {
    const r = await processProposedAction({
      action: {
        actionKind: 'post',
        target: { channel: 'moltbook', text: 'API_KEY=sk-ant-' + 'a'.repeat(95) },
        rationale: 'launch',
      },
      dataDir,
    });
    expect(r.decision).toBe('block');
    expect(r.dlpDecision).toBe('block');
    expect(r.blockers.length).toBeGreaterThan(0);
  });

  test('read_kb action → allow (read-only retrieval, no egress)', async () => {
    const r = await processProposedAction({
      action: {
        actionKind: 'read_kb',
        target: { project: 'recall-dev', category: 'decisions' },
        rationale: 'context fetch',
      },
      dataDir,
    });
    expect(r.decision).toBe('allow');
  });

  test('every proposed action is recorded in audit-ingest as untrusted', async () => {
    await processProposedAction({
      action: { actionKind: 'post', target: { text: 'hi' }, rationale: 'a' },
      dataDir,
    });
    await processProposedAction({
      action: { actionKind: 'read_kb', target: {}, rationale: 'b' },
      dataDir,
    });
    const records = listAuditRecords({ dataDir });
    expect(records.length).toBe(2);
    for (const r of records) {
      expect(r.status).toBe('untrusted');
      expect(r.agentId).toBe('openclaw-runtime-stub');
    }
  });

  test('throws when action is missing actionKind', async () => {
    await expect(processProposedAction({ action: { target: {} }, dataDir })).rejects.toThrow(/actionKind/);
  });

  test('respects custom agentId', async () => {
    await processProposedAction({
      action: { actionKind: 'post', target: { text: 'hi' } },
      agentId: 'openclaw-mac-mini',
      dataDir,
    });
    const records = listAuditRecords({ dataDir });
    expect(records[0].agentId).toBe('openclaw-mac-mini');
  });

  test('blocked action outcome reflects the block', async () => {
    await processProposedAction({
      action: {
        actionKind: 'post',
        target: { channel: 'moltbook', text: 'leak: sk-ant-' + 'x'.repeat(95) },
      },
      dataDir,
    });
    const records = listAuditRecords({ dataDir });
    expect(records[0].outcome).toBe('blocked');
  });

  test('http_request action is treated as egress (review boundary)', async () => {
    const r = await processProposedAction({
      action: {
        actionKind: 'http_request',
        target: { url: 'https://api.example.com/post', method: 'POST' },
        rationale: 'webhook',
      },
      dataDir,
    });
    expect(r.decision).toBe('review');
  });

  test('action with no text content still records but DLP returns allow', async () => {
    const r = await processProposedAction({
      action: { actionKind: 'tool_call', target: { tool: 'calculator', args: { a: 1, b: 2 } } },
      dataDir,
    });
    expect(r.dlpDecision).toBe('allow');
    expect(r.recordId).toMatch(/^audit-/);
  });
});
