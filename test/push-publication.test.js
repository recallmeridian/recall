'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readAuditEvents } = require('../lib/audit-sediment');
const {
  defaultAuditPath,
  evaluatePushEntry,
  recordDryRunPush,
} = require('../lib/push-publication');

function entry(overrides = {}) {
  return {
    schemaVersion: '4.0',
    id: 'push-entry-1',
    name: 'Reviewed local feature summary',
    description: 'A reviewed summary from local Recall experimentation.',
    status: 'active',
    category: 'summary',
    tags: ['reviewed'],
    projectId: 'recall-local',
    source: 'local-review',
    partition: 'trusted_kb',
    source_trust_level: 'trusted',
    content_hash: `sha256:${'a'.repeat(64)}`,
    ...overrides,
  };
}

describe('GEO-SEC-024 push dry-run publication wiring', () => {
  let dir;
  let auditPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-sec-024-'));
    auditPath = path.join(dir, 'audit-sediment.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('evaluates a trusted entry through publication policy without legacy schema 3 payload drift', async () => {
    const result = await evaluatePushEntry(entry(), 'recall-local', {
      dataRoot: dir,
      publicationTarget: 'meridian-signed-http-v1',
      requestId: 'req-024',
      createdAt: '2026-05-03T00:00:00.000Z',
    });

    expect(result.decision).toBe('allow');
    expect(result.payload).toMatchObject({
      id: 'push-entry-1',
      projectId: 'recall-local',
      schemaVersion: '4.0',
    });
    expect(result.payload).not.toHaveProperty('partition');
    expect(result.payload).not.toHaveProperty('_extensions');
    expect(result.envelope).toMatchObject({
      envelopeVersion: 'meridian-publication-v1',
      requestId: 'req-024',
      payload: {
        type: 'entry',
        schemaVersion: '4.0',
      },
      signature: {
        scheme: 'meridian-envelope-v1',
        value: '',
        placeholder: true,
      },
    });
    expect(result.envelopeHash).toBe(result.envelope.payloadHash);
    expect(result.auditEvent).toMatchObject({
      eventType: 'publication_attempt',
      runtimeMode: 'recall-local',
      target: 'meridian-signed-http-v1',
      policyDecision: 'allow',
      requestId: 'req-024',
    });
  });

  test('records dry-run denials as audit sediment and does not produce a publish payload', async () => {
    const result = await recordDryRunPush(entry({
      status: 'draft',
      partition: 'candidate_basin',
      source_trust_level: 'external_low',
    }), 'recall-local', {
      dataRoot: dir,
      auditPath,
      requestId: 'req-deny-024',
    });
    const events = readAuditEvents(auditPath);

    expect(result.decision).toBe('deny');
    expect(result.payload).toBeNull();
    expect(result.envelope).toBeNull();
    expect(result.reasons).toEqual(expect.arrayContaining([
      'status_draft',
      'partition_candidate_basin',
      'source_trust_external_low',
    ]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'publication_attempt',
      actor: 'push-command',
      action: 'dry_run_publication_policy',
      resource: {
        id: 'push-entry-1',
        type: 'entry',
        projectId: 'recall-local',
      },
      partition: 'candidate_basin',
      policyResult: 'deny',
    });
  });

  test('uses the local Recall data directory as the default audit sediment outlet', async () => {
    const expected = path.join(dir, 'audit-sediment.jsonl');

    await recordDryRunPush(entry(), 'recall-local', { dataRoot: dir });

    expect(defaultAuditPath(dir)).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
    expect(readAuditEvents(expected)).toHaveLength(1);
  });

  test('requires helper callers to provide an auditPath or dataRoot', async () => {
    const signingService = { sign: jest.fn(async () => 'should-not-sign') };

    await expect(recordDryRunPush(entry(), 'recall-local')).rejects.toThrow(
      'recordDryRunPush requires options.auditPath or options.dataRoot'
    );
    await expect(recordDryRunPush(entry(), 'recall-local', { signingService })).rejects.toThrow(
      'recordDryRunPush requires options.auditPath or options.dataRoot'
    );
    expect(signingService.sign).not.toHaveBeenCalled();
  });
});
