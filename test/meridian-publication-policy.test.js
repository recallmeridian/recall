'use strict';

const path = require('path');
const { canonicalSha256, canonicalize, evaluatePublicationPolicy, PAYLOAD_ALLOWLIST } = require('../lib/publication-policy');

const DATA_ROOT = path.join('C:', 'Users', 'jesse', '.meridian');
const CONTEXT = {
  runtimeMode: 'recall-local',
  dataRoot: DATA_ROOT,
  publicationTarget: 'meridian-signed-http-v1',
  publicationProjectId: 'published-recall',
  publisherKeyId: 'ed25519:test',
  requestId: 'req-geo-sec-013',
};

function trustedEntry(overrides = {}) {
  return {
    schemaVersion: '4.0',
    id: 'trusted-1',
    name: 'Reviewed terrain summary',
    description: 'A reviewed trusted summary derived from local evidence.',
    status: 'active',
    category: 'summary',
    tags: ['reviewed'],
    projectId: 'local-recall',
    source: 'local-review',
    sourcePath: path.join(DATA_ROOT, 'projects', 'recall', 'trusted-1.json'),
    partition: 'trusted_kb',
    source_trust_level: 'trusted',
    content_hash: `sha256:${'a'.repeat(64)}`,
    ...overrides,
  };
}

describe('GEO-SEC-013 push/publication denylist', () => {
  test('allows one clean reviewed trusted entry with an allowlisted payload', () => {
    const result = evaluatePublicationPolicy(trustedEntry(), CONTEXT);

    expect(result.decision).toBe('allow');
    expect(result.reasons).toEqual([]);
    expect(result.publicationClass).toBe('reviewed_entry');
    expect(result.payloadAllowlist).toEqual(PAYLOAD_ALLOWLIST);
    expect(Object.keys(result.payload).sort()).toEqual([
      'category',
      'content_hash',
      'description',
      'id',
      'name',
      'projectId',
      'schemaVersion',
      'source',
      'status',
      'tags',
    ].sort());
    expect(result.payload).not.toHaveProperty('_extensions');
    expect(result.auditEvent).toMatchObject({
      eventType: 'publication_attempt',
      runtimeMode: 'recall-local',
      entryId: 'trusted-1',
      projectId: 'local-recall',
      target: 'meridian-signed-http-v1',
      policyDecision: 'allow',
      policyReasons: [],
      publisherKeyId: 'ed25519:test',
      requestId: 'req-geo-sec-013',
    });
    expect(result.auditEvent.payloadHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test.each([
    ['draft entries', { status: 'draft' }, 'status_draft'],
    ['retired entries', { status: 'retired' }, 'status_retired'],
    ['candidate partition', { partition: 'candidate_basin' }, 'partition_candidate_basin'],
    ['quarantine partition', { partition: 'quarantine_basin' }, 'partition_quarantine_basin'],
    ['sensitive vault partition', { partition: 'sensitive_vault' }, 'partition_sensitive_vault'],
    ['external low trust', { source_trust_level: 'external_low' }, 'source_trust_external_low'],
    ['untrusted source', { source_trust_level: 'untrusted' }, 'source_trust_untrusted'],
    ['unresolved prompt injection', { promptInjectionStatus: 'unresolved' }, 'unresolved_prompt_injection'],
    ['export without approval', { exportPipeline: true }, 'export_without_publication_approval'],
    ['raw private telemetry', { category: 'raw-private-telemetry' }, 'raw_external_content'],
    ['local feature run state', { category: 'local-feature-run' }, 'local_or_unvalidated_feature'],
    ['unvalidated feature manifest', { category: 'feature-manifest', _extensions: { featureValidation: 'draft' } }, 'local_or_unvalidated_feature'],
  ])('denies %s with a specific policy reason', (_name, overrides, reason) => {
    const result = evaluatePublicationPolicy(trustedEntry(overrides), CONTEXT);

    expect(result.decision).toBe('deny');
    expect(result.reasons).toContain(reason);
    expect(result.payload).toBeNull();
    expect(result.auditEvent).toMatchObject({
      eventType: 'publication_attempt',
      policyDecision: 'deny',
    });
    expect(result.auditEvent.policyReasons).toContain(reason);
  });

  test('denies obvious secret-shaped values', () => {
    const result = evaluatePublicationPolicy(trustedEntry({
      description: 'Deploy note API_KEY=super-secret-value',
    }), CONTEXT);

    expect(result.decision).toBe('deny');
    expect(result.reasons).toContain('secret_shaped_value');
    expect(JSON.stringify(result.auditEvent)).not.toContain('super-secret-value');
  });

  test('denies adjacent .recall and outside-data-root source paths', () => {
    const adjacent = evaluatePublicationPolicy(trustedEntry({
      sourcePath: path.join('C:', 'Users', 'jesse', '.recall', 'projects', 'meridian', 'extracts', 'entry.md'),
    }), CONTEXT);
    const outside = evaluatePublicationPolicy(trustedEntry({
      sourcePath: path.join('C:', 'Users', 'jesse', 'Downloads', 'entry.md'),
    }), CONTEXT);

    expect(adjacent.decision).toBe('deny');
    expect(adjacent.reasons).toEqual(expect.arrayContaining([
      'adjacent_recall_source_path',
      'source_path_outside_data_root',
    ]));
    expect(outside.decision).toBe('deny');
    expect(outside.reasons).toContain('source_path_outside_data_root');
  });

  test('does not trust caller-supplied publication decisions or claims', () => {
    const result = evaluatePublicationPolicy(trustedEntry({
      status: 'draft',
      publicationDecision: 'allow',
      publicationClass: 'reviewed_entry',
      publicationClaim: {
        partitionClaim: 'trusted_kb',
      },
    }), CONTEXT);

    expect(result.decision).toBe('deny');
    expect(result.publicationClass).toBe('denied');
    expect(result.reasons).toContain('status_draft');
  });

  test('denies a misleading semantic shell when the claim lives in _extensions', () => {
    const result = evaluatePublicationPolicy(trustedEntry({
      description: '',
      _extensions: {
        publicationCritical: true,
        claim: 'The actual publishable claim is only here.',
      },
    }), CONTEXT);

    expect(result.decision).toBe('deny');
    expect(result.reasons).toContain('semantic_shell_after_allowlist');
  });

  test('redacts local source paths from allowed payloads', () => {
    const result = evaluatePublicationPolicy(trustedEntry({
      source: path.join(DATA_ROOT, 'projects', 'recall', 'trusted-1.json'),
    }), CONTEXT);

    expect(result.decision).toBe('allow');
    expect(result.payload.source).toBe('[redacted-local-path]');
    expect(result.redactions).toEqual(['source']);
  });

  test('uses canonical JSON hashing instead of insertion-order JSON.stringify hashing', () => {
    const first = canonicalSha256({ b: 2, a: { d: 4, c: 3 } });
    const second = canonicalSha256({ a: { c: 3, d: 4 }, b: 2 });

    expect(canonicalize({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(first).toBe(second);
  });
});
