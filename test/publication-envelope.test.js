'use strict';

const {
  COVERED_FIELDS,
  ENVELOPE_VERSION,
  SIGNATURE_SCHEME,
  buildPublicationEnvelope,
  signingPayload,
} = require('../lib/publication-envelope');
const { evaluatePublicationPolicy } = require('../lib/publication-policy');

function entry(overrides = {}) {
  return {
    schemaVersion: '4.0',
    id: 'envelope-entry-1',
    name: 'Reviewed envelope note',
    description: 'A reviewed note ready for a publication envelope.',
    status: 'active',
    category: 'summary',
    projectId: 'recall-local',
    source: 'local-review',
    partition: 'trusted_kb',
    source_trust_level: 'trusted',
    content_hash: `sha256:${'b'.repeat(64)}`,
    ...overrides,
  };
}

describe('GEO-SEC-025 signed envelope placeholder', () => {
  test('builds the Meridian v1 envelope shape with a null-local signature placeholder', async () => {
    const sourceEntry = entry();
    const context = {
      runtimeMode: 'recall-local',
      publicationTarget: 'meridian-signed-http-v1',
      publisherId: 'local-publisher',
      publisherKeyId: 'null-local',
      requestId: 'req-envelope-025',
      createdAt: '2026-05-03T00:00:00.000Z',
      revision: 2,
    };
    const policy = evaluatePublicationPolicy(sourceEntry, context);
    const envelope = await buildPublicationEnvelope(policy, sourceEntry, context);

    expect(envelope).toMatchObject({
      envelopeVersion: ENVELOPE_VERSION,
      requestId: 'req-envelope-025',
      createdAt: '2026-05-03T00:00:00.000Z',
      expiresAt: '2026-05-03T00:05:00.000Z',
      publisher: {
        publisherId: 'local-publisher',
        keyId: 'null-local',
        algorithm: 'null-local',
      },
      source: {
        runtimeMode: 'recall-local',
        projectId: 'recall-local',
        entryId: 'envelope-entry-1',
      },
      publicationClaim: {
        partitionClaim: 'trusted_kb',
        source_trust_level_claim: 'trusted',
        publicationClassClaim: 'reviewed_entry',
        revision: 2,
      },
      signature: {
        scheme: SIGNATURE_SCHEME,
        coveredFields: COVERED_FIELDS,
        value: '',
        placeholder: true,
      },
    });
    expect(envelope.payload).toMatchObject({
      type: 'entry',
      schemaVersion: '4.0',
      entry: policy.payload,
    });
    expect(envelope.payloadHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(envelope.publicationId).toBe(envelope.payloadHash);
    expect(envelope.idempotencyKey).toBe(`null-local:${envelope.payloadHash}:meridian-signed-http-v1:2`);
  });

  test('signs only covered envelope fields and excludes the signature object', async () => {
    const signer = {
      sign: jest.fn(async (payload) => `signed:${Object.keys(payload).join('|')}`),
    };
    const sourceEntry = entry();
    const policy = evaluatePublicationPolicy(sourceEntry, {
      runtimeMode: 'recall-local',
      publicationTarget: 'meridian-signed-http-v1',
      publisherKeyId: 'ed25519:test',
      requestId: 'req-signed-025',
      createdAt: '2026-05-03T00:00:00.000Z',
    });
    const envelope = await buildPublicationEnvelope(policy, sourceEntry, {
      runtimeMode: 'recall-local',
      publicationTarget: 'meridian-signed-http-v1',
      publisherKeyId: 'ed25519:test',
      requestId: 'req-signed-025',
      createdAt: '2026-05-03T00:00:00.000Z',
    }, signer);

    expect(signer.sign).toHaveBeenCalledTimes(1);
    expect(signer.sign).toHaveBeenCalledWith(signingPayload(envelope));
    expect(signer.sign.mock.calls[0][0]).not.toHaveProperty('payload');
    expect(signer.sign.mock.calls[0][0]).not.toHaveProperty('signature');
    expect(envelope.signature).toMatchObject({
      value: 'signed:envelopeVersion|requestId|idempotencyKey|createdAt|expiresAt|publisher|source|publicationClaim|payloadHash',
      placeholder: false,
    });
  });

  test('does not build an envelope for denied publication policy results', async () => {
    const sourceEntry = entry({ status: 'draft', partition: 'candidate_basin' });
    const policy = evaluatePublicationPolicy(sourceEntry, {
      runtimeMode: 'recall-local',
      publicationTarget: 'meridian-signed-http-v1',
    });

    await expect(buildPublicationEnvelope(policy, sourceEntry)).resolves.toBeNull();
  });
});
