'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  STATUS,
  submitAuditRecord,
  listAuditRecords,
  getAuditRecord,
  promoteAuditRecord,
  rejectAuditRecord,
  verifyAuditLedger,
} = require('../lib/security/audit-ingest');

describe('OpenClaw Audit Ingest', () => {
  let dataDir;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-ingest-test-'));
  });
  afterEach(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('submitAuditRecord defaults status to untrusted', () => {
    const r = submitAuditRecord({
      agentId: 'openclaw-mac',
      actionKind: 'post',
      target: { channel: 'moltbook', text: 'hello' },
      rationale: 'launch announcement',
    }, { dataDir });
    expect(r.recordId).toMatch(/^audit-/);
    expect(r.entry.statusAfter).toBe(STATUS.UNTRUSTED);
    expect(r.entry.sequence).toBe(1);
    expect(r.entry.previousHash).toBeNull();
  });

  test('throws when required fields missing', () => {
    expect(() => submitAuditRecord({ actionKind: 'post' }, { dataDir })).toThrow(/agentId/);
    expect(() => submitAuditRecord({ agentId: 'a' }, { dataDir })).toThrow(/actionKind/);
  });

  test('listAuditRecords filters by status and agentId', () => {
    submitAuditRecord({ agentId: 'a1', actionKind: 'post', target: { x: 1 } }, { dataDir });
    submitAuditRecord({ agentId: 'a2', actionKind: 'post', target: { x: 2 } }, { dataDir });
    submitAuditRecord({ agentId: 'a1', actionKind: 'tool_call', target: { x: 3 } }, { dataDir });
    expect(listAuditRecords({ dataDir }).length).toBe(3);
    expect(listAuditRecords({ dataDir, agentId: 'a1' }).length).toBe(2);
    expect(listAuditRecords({ dataDir, status: STATUS.UNTRUSTED }).length).toBe(3);
    expect(listAuditRecords({ dataDir, status: STATUS.TRUSTED }).length).toBe(0);
  });

  test('promoteAuditRecord requires humanApproval and moves to trusted', () => {
    const { recordId } = submitAuditRecord(
      { agentId: 'openclaw', actionKind: 'post', target: { x: 1 } },
      { dataDir }
    );
    expect(() => promoteAuditRecord(recordId, {}, { dataDir })).toThrow(/humanApproval/);
    promoteAuditRecord(recordId, { humanApproval: 'jesse@2026-05-13:approved' }, { dataDir });
    const r = getAuditRecord(recordId, { dataDir });
    expect(r.status).toBe(STATUS.TRUSTED);
    expect(r.approvalRef).toBe('jesse@2026-05-13:approved');
    expect(r.eventCount).toBe(2);
  });

  test('promoteAuditRecord refuses to promote a non-untrusted record', () => {
    const { recordId } = submitAuditRecord({ agentId: 'a', actionKind: 'post', target: {} }, { dataDir });
    rejectAuditRecord(recordId, { reason: 'looked sketchy' }, { dataDir });
    expect(() => promoteAuditRecord(recordId, { humanApproval: 'h' }, { dataDir })).toThrow(/not in untrusted/);
  });

  test('rejectAuditRecord requires reason and moves to rejected', () => {
    const { recordId } = submitAuditRecord({ agentId: 'a', actionKind: 'post', target: {} }, { dataDir });
    expect(() => rejectAuditRecord(recordId, {}, { dataDir })).toThrow(/reason/);
    rejectAuditRecord(recordId, { reason: 'leaks private path' }, { dataDir });
    const r = getAuditRecord(recordId, { dataDir });
    expect(r.status).toBe(STATUS.REJECTED);
    expect(r.rejectReason).toBe('leaks private path');
  });

  test('cannot reject twice', () => {
    const { recordId } = submitAuditRecord({ agentId: 'a', actionKind: 'post', target: {} }, { dataDir });
    rejectAuditRecord(recordId, { reason: 'r1' }, { dataDir });
    expect(() => rejectAuditRecord(recordId, { reason: 'r2' }, { dataDir })).toThrow(/already rejected/);
  });

  test('lifecycle is auditable: walking events reconstructs the trail', () => {
    const { recordId } = submitAuditRecord({ agentId: 'a', actionKind: 'post', target: {} }, { dataDir });
    promoteAuditRecord(recordId, { humanApproval: 'h1' }, { dataDir });
    const r = getAuditRecord(recordId, { dataDir });
    expect(r.eventCount).toBe(2); // submitted + promoted
    expect(r.status).toBe(STATUS.TRUSTED);
  });

  test('hash chain links all events across all records', () => {
    submitAuditRecord({ agentId: 'a', actionKind: 'post', target: {} }, { dataDir });
    submitAuditRecord({ agentId: 'b', actionKind: 'post', target: {} }, { dataDir });
    const r = verifyAuditLedger({ dataDir });
    expect(r.ok).toBe(true);
    expect(r.entries).toBe(2);
  });

  test('verifyAuditLedger detects tampering', () => {
    submitAuditRecord({ agentId: 'a', actionKind: 'post', target: {} }, { dataDir });
    submitAuditRecord({ agentId: 'b', actionKind: 'post', target: {} }, { dataDir });
    const filePath = path.join(dataDir, 'security', 'audit-ingest-ledger.jsonl');
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[0]);
    tampered.statusAfter = STATUS.TRUSTED; // forge promotion
    lines[0] = JSON.stringify(tampered);
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
    const r = verifyAuditLedger({ dataDir });
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe(1);
  });

  test('limit caps the result count and returns most-recently-updated first', () => {
    for (let i = 0; i < 5; i++) {
      submitAuditRecord({ agentId: 'a', actionKind: 'post', target: { i } }, { dataDir });
    }
    const r = listAuditRecords({ dataDir, limit: 3 });
    expect(r.length).toBe(3);
  });
});
