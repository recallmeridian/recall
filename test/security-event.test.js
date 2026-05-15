'use strict';

const {
  CLOUD_EVENT_SPEC_VERSION,
  SECURITY_EVENT_SCHEMA_VERSION,
  normalizeSecurityEvent,
  validateSecurityEvent,
} = require('../lib/security-event');
const { normalizeAuditEvent } = require('../lib/audit-sediment');

describe('GEO-SEC-035 security event contract', () => {
  test('normalizes quarantine classifier events into security-event/v1', () => {
    const event = normalizeSecurityEvent({
      type: 'quarantine_classification',
      timestamp: '2026-05-03T00:00:00.000Z',
      classifier_reason: ['line_start_role_directive'],
      content_hash: 'sha256:abc',
    }, {
      actor: 'intake-classifier',
      action: 'classify_imported_content',
      resourceId: 'entry-1',
      partition: 'quarantine_basin',
      source_trust_level: 'untrusted',
      projectId: 'recall-local',
    });

    expect(event).toMatchObject({
      eventSchemaVersion: SECURITY_EVENT_SCHEMA_VERSION,
      specversion: CLOUD_EVENT_SPEC_VERSION,
      id: 'sha256:abc',
      source: 'recall://local/security',
      type: 'dev.recall.security.quarantine_classification',
      subject: 'resource/entry-1',
      time: '2026-05-03T00:00:00.000Z',
      datacontenttype: 'application/json',
      eventType: 'quarantine_classification',
      actor: 'intake-classifier',
      action: 'classify_imported_content',
      partition: 'quarantine_basin',
      source_trust_level: 'untrusted',
      policyResult: 'quarantine',
      reasons: ['line_start_role_directive'],
      policy: {
        result: 'quarantine',
        reasons: ['line_start_role_directive'],
      },
      resource: {
        id: 'entry-1',
        projectId: 'recall-local',
        partition: 'quarantine_basin',
        source_trust_level: 'untrusted',
      },
      hashes: {
        content_hash: 'sha256:abc',
      },
      attributes: {
        'event.name': 'quarantine_classification',
        'event.domain': 'recall.security',
        'recall.project_id': 'recall-local',
        'recall.resource_id': 'entry-1',
        'recall.partition': 'quarantine_basin',
        'recall.source_trust_level': 'untrusted',
        'recall.policy_result': 'quarantine',
        'recall.policy_reasons': 'line_start_role_directive',
        'recall.actor': 'intake-classifier',
        'recall.action': 'classify_imported_content',
      },
    });
    expect(validateSecurityEvent(event)).toEqual({ ok: true, errors: [] });
  });

  test('normalizes policy events while preserving legacy audit fields', () => {
    const event = normalizeAuditEvent({
      eventType: 'publication_attempt',
      entryId: 'entry-2',
      projectId: 'research',
      policyDecision: 'deny',
      policyReasons: ['partition_candidate_basin'],
      payloadHash: 'sha256:def',
    }, {
      actor: 'publication-policy',
      action: 'evaluate_publication_policy',
      partition: 'candidate_basin',
    });

    expect(event).toMatchObject({
      eventSchemaVersion: SECURITY_EVENT_SCHEMA_VERSION,
      specversion: CLOUD_EVENT_SPEC_VERSION,
      type: 'dev.recall.security.publication_attempt',
      eventType: 'publication_attempt',
      actor: 'publication-policy',
      action: 'evaluate_publication_policy',
      policyResult: 'deny',
      reasons: ['partition_candidate_basin'],
      policy: {
        result: 'deny',
        reasons: ['partition_candidate_basin'],
      },
      resource: {
        id: 'entry-2',
        type: 'entry',
        projectId: 'research',
        partition: 'candidate_basin',
      },
    });
  });

  test('fails validation when required fields are missing', () => {
    expect(validateSecurityEvent({
      eventSchemaVersion: SECURITY_EVENT_SCHEMA_VERSION,
      specversion: CLOUD_EVENT_SPEC_VERSION,
      eventType: 'feature_capability_check',
      timestamp: '2026-05-03T00:00:00.000Z',
      source: '',
      type: '',
      id: '',
      resource: { id: '' },
      policy: { result: '' },
    })).toEqual({
      ok: false,
      errors: [
        'cloudevents_id_required',
        'cloudevents_source_required',
        'cloudevents_type_required',
        'resource_id_required',
        'policy_result_required',
      ],
    });
  });
});
