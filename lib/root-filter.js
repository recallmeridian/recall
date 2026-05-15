'use strict';

const crypto = require('crypto');
const {
  classifyImportedContentForRouting,
} = require('./quarantine-routing');

const ROOT_FILTER_CONTRACT_VERSION = 'root-filter.v1';

const ROOT_FILTER_ACTIONS = Object.freeze({
  DISCARD: 'discard',
  QUARANTINE: 'quarantine',
  CANDIDATE: 'candidate',
  TRUSTED_WRITE: 'trusted_write',
  VAULT_REVIEW: 'vault_review',
});

const TRUSTED_SOURCE_LEVELS = new Set([
  'trusted',
  'local_trusted',
  'human_verified',
  'validated',
]);

const TRUSTED_SOURCE_TYPES = new Set([
  'manual_note',
  'local_note',
  'human_authored',
  'validated_recall_entry',
  'trusted_kb',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function getRecordText(record) {
  if (!record || typeof record !== 'object') return '';
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  if (typeof record.body === 'string') return record.body;
  return '';
}

function normalizeContentHash(value, fallbackText) {
  if (typeof value === 'string') {
    const normalized = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
    if (/^[a-f0-9]{64}$/i.test(normalized)) return `sha256:${normalized.toLowerCase()}`;
  }
  return `sha256:${sha256(fallbackText)}`;
}

function field(record, context, snake, camel, fallback = undefined) {
  if (context && context[snake] !== undefined) return context[snake];
  if (context && context[camel] !== undefined) return context[camel];
  if (record && record[snake] !== undefined) return record[snake];
  if (record && record[camel] !== undefined) return record[camel];
  return fallback;
}

function inferSourceType(record, context) {
  return field(record, context, 'source_type', 'sourceType')
    || (record && record.source)
    || (record && record.kind)
    || 'unknown';
}

function inferSourceUri(record, context) {
  return field(record, context, 'source_uri', 'sourceUri')
    || (record && record.sourcePath)
    || (record && record.uri)
    || null;
}

function isTrustedWriteAllowed(record, context) {
  if (!context || context.allowTrustedWrite !== true) return false;
  const sourceTrustLevel = field(record, context, 'source_trust_level', 'sourceTrustLevel');
  const sourceType = inferSourceType(record, context);
  return TRUSTED_SOURCE_LEVELS.has(sourceTrustLevel) && TRUSTED_SOURCE_TYPES.has(sourceType);
}

function buildAuditEvent(action, timestamp, reasons, contentHash) {
  return {
    type: 'root_filter_decision',
    timestamp,
    root_filter_contract: ROOT_FILTER_CONTRACT_VERSION,
    root_filter_action: action,
    classifier_reason: reasons,
    content_hash: contentHash,
  };
}

function buildDecision(record, context, overrides) {
  const text = getRecordText(record);
  const timestamp = context.now || context.timestamp || new Date().toISOString();
  const sourceType = inferSourceType(record, context);
  const sourceUri = inferSourceUri(record, context);
  const contentHash = normalizeContentHash(
    record && (record.hash || record.content_hash || record.contentHash),
    text
  );
  const reasons = overrides.classification_reason || overrides.reasons || [];

  return {
    contract_version: ROOT_FILTER_CONTRACT_VERSION,
    stage: 'root_filter',
    action: overrides.action,
    decision: overrides.action,
    partition: overrides.partition,
    source_trust_level: overrides.source_trust_level,
    classification_reason: reasons,
    allowed_retrieval_modes: overrides.allowed_retrieval_modes || [],
    allowed_tool_scopes: overrides.allowed_tool_scopes || [],
    provenance: {
      entry_id: field(record, context, 'entry_id', 'entryId') || (record && record.id) || null,
      project_id: field(record, context, 'project_id', 'projectId') || null,
      owner_id: field(record, context, 'owner_id', 'ownerId') || null,
      source_type: sourceType,
      source_uri: sourceUri,
      content_hash: contentHash,
      ingested_at: timestamp,
    },
    auditEvent: buildAuditEvent(overrides.action, timestamp, reasons, contentHash),
  };
}

function evaluateRootFilter(record, context = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return buildDecision(record, context, {
      action: ROOT_FILTER_ACTIONS.DISCARD,
      partition: 'working_context',
      source_trust_level: 'invalid',
      classification_reason: ['invalid_record'],
    });
  }

  const text = getRecordText(record);
  if (text.trim().length === 0) {
    return buildDecision(record, context, {
      action: ROOT_FILTER_ACTIONS.DISCARD,
      partition: 'working_context',
      source_trust_level: 'invalid',
      classification_reason: ['empty_content'],
    });
  }

  const requestedPartition = field(record, context, 'partition', 'partition');
  if (requestedPartition === 'sensitive_vault' || context.sensitive === true) {
    return buildDecision(record, context, {
      action: ROOT_FILTER_ACTIONS.VAULT_REVIEW,
      partition: 'sensitive_vault',
      source_trust_level: 'sensitive',
      classification_reason: ['sensitive_vault_source'],
      allowed_retrieval_modes: ['explicit_sensitive_review'],
    });
  }

  const routing = classifyImportedContentForRouting(record, context);
  if (routing.decision === ROOT_FILTER_ACTIONS.QUARANTINE) {
    return buildDecision(record, context, {
      action: ROOT_FILTER_ACTIONS.QUARANTINE,
      partition: routing.partition,
      source_trust_level: routing.source_trust_level,
      classification_reason: routing.classification_reason,
      allowed_retrieval_modes: routing.allowed_retrieval_modes,
      allowed_tool_scopes: routing.allowed_tool_scopes,
    });
  }

  if (isTrustedWriteAllowed(record, context)) {
    return buildDecision(record, context, {
      action: ROOT_FILTER_ACTIONS.TRUSTED_WRITE,
      partition: 'trusted_kb',
      source_trust_level: field(record, context, 'source_trust_level', 'sourceTrustLevel'),
      classification_reason: ['trusted_source_explicit_write'],
      allowed_retrieval_modes: ['normal', 'trusted'],
      allowed_tool_scopes: [],
    });
  }

  return buildDecision(record, context, {
    action: ROOT_FILTER_ACTIONS.CANDIDATE,
    partition: routing.partition,
    source_trust_level: routing.source_trust_level,
    classification_reason: routing.classification_reason,
    allowed_retrieval_modes: routing.allowed_retrieval_modes,
    allowed_tool_scopes: routing.allowed_tool_scopes,
  });
}

function applyRootFilterMetadata(entry, decision) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('entry must be an object');
  }
  if (!decision || decision.contract_version !== ROOT_FILTER_CONTRACT_VERSION) {
    throw new TypeError('decision must be a Root Filter v1 decision');
  }

  return {
    ...entry,
    partition: decision.partition,
    source_trust_level: decision.source_trust_level,
    classification_reason: decision.classification_reason,
    allowed_retrieval_modes: decision.allowed_retrieval_modes,
    allowed_tool_scopes: decision.allowed_tool_scopes,
    content_hash: decision.provenance.content_hash,
    root_filter: {
      contract_version: decision.contract_version,
      action: decision.action,
      stage: decision.stage,
      provenance: decision.provenance,
    },
  };
}

module.exports = {
  ROOT_FILTER_ACTIONS,
  ROOT_FILTER_CONTRACT_VERSION,
  applyRootFilterMetadata,
  evaluateRootFilter,
};
