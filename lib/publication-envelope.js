'use strict';

const { canonicalSha256 } = require('./canonical-json');

const ENVELOPE_VERSION = 'meridian-publication-v1';
const SIGNATURE_SCHEME = 'meridian-envelope-v1';
const COVERED_FIELDS = [
  'envelopeVersion',
  'requestId',
  'idempotencyKey',
  'createdAt',
  'expiresAt',
  'publisher',
  'source',
  'publicationClaim',
  'payloadHash',
];

class LocalNullSigningService {
  async sign() {
    return '';
  }

  async verify() {
    return true;
  }
}

function defaultSigningService() {
  try {
    const { NullSigningService } = require('./meridian-core/adapters');
    return new NullSigningService();
  } catch (_) {
    return new LocalNullSigningService();
  }
}

function addMinutes(isoTimestamp, minutes) {
  return new Date(new Date(isoTimestamp).getTime() + minutes * 60 * 1000).toISOString();
}

function signingPayload(envelope) {
  const covered = {};
  for (const field of COVERED_FIELDS) {
    covered[field] = envelope[field];
  }
  return covered;
}

async function buildPublicationEnvelope(policyResult, entry, context = {}, signingService = defaultSigningService()) {
  if (!policyResult || policyResult.decision !== 'allow' || !policyResult.payload) {
    return null;
  }

  const payload = {
    type: 'entry',
    schemaVersion: policyResult.payload.schemaVersion || entry.schemaVersion || '4.0',
    entry: policyResult.payload,
  };
  const payloadHash = canonicalSha256(payload);
  const createdAt = context.createdAt || context.now || new Date().toISOString();
  const expiresAt = context.expiresAt || addMinutes(createdAt, 5);
  const publisherKeyId = context.publisherKeyId || 'null-local';
  const revision = context.revision || 0;
  const target = context.publicationTarget || 'meridian-signed-http-v1';
  const requestId = context.requestId || `${target}:${entry.id}:${payloadHash}`;
  const publisher = {
    publisherId: context.publisherId || 'recall-local',
    keyId: publisherKeyId,
    algorithm: context.publisherAlgorithm || (publisherKeyId === 'null-local' ? 'null-local' : 'ed25519'),
  };
  const envelope = {
    envelopeVersion: ENVELOPE_VERSION,
    requestId,
    idempotencyKey: `${publisher.keyId}:${payloadHash}:${target}:${revision}`,
    createdAt,
    expiresAt,
    publisher,
    source: {
      runtimeMode: context.runtimeMode || 'recall-local',
      projectId: entry.projectId || context.projectId || context.publicationProjectId || '',
      entryId: entry.id,
      promotionEventId: context.promotionEventId || '',
    },
    publicationClaim: {
      partitionClaim: entry.partition || entry.partitionClaim || (entry._extensions && entry._extensions.partition) || 'trusted_kb',
      source_trust_level_claim: entry.source_trust_level || entry.sourceTrustLevel || 'trusted',
      publicationClassClaim: policyResult.publicationClass || 'reviewed_entry',
      revision,
    },
    payload,
    payloadHash,
  };
  const signatureValue = await signingService.sign(signingPayload(envelope));

  return {
    ...envelope,
    publicationId: payloadHash,
    signature: {
      scheme: SIGNATURE_SCHEME,
      coveredFields: COVERED_FIELDS.slice(),
      value: signatureValue,
      placeholder: signatureValue === '',
    },
  };
}

module.exports = {
  COVERED_FIELDS,
  ENVELOPE_VERSION,
  SIGNATURE_SCHEME,
  buildPublicationEnvelope,
  defaultSigningService,
  signingPayload,
};
