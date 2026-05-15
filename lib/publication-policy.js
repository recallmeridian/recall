'use strict';

const path = require('path');
const { canonicalize, canonicalSha256 } = require('./canonical-json');

const PAYLOAD_ALLOWLIST = [
  'id',
  'name',
  'description',
  'status',
  'category',
  'tags',
  'projectId',
  'source',
  'content_hash',
  'schemaVersion',
];

const SECRET_PATTERNS = [
  /\b[A-Z0-9_]*(API|ACCESS|SECRET|TOKEN|KEY)[A-Z0-9_]*\s*=\s*["']?[^"'\s]+/i,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizePath(value) {
  if (!value) return '';
  return path.resolve(String(value)).toLowerCase();
}

function isWithin(root, candidate) {
  const normalizedRoot = normalizePath(root);
  const normalizedCandidate = normalizePath(candidate);
  if (!normalizedRoot || !normalizedCandidate) return false;
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function getSourcePath(entry) {
  return entry.sourcePath
    || entry.source_uri
    || entry.sourceUri
    || (entry.provenance && (entry.provenance.sourcePath || entry.provenance.source_uri || entry.provenance.sourceUri))
    || '';
}

function containsSecretShapedValue(value) {
  const seen = new Set();

  function visit(current) {
    if (current == null) return false;
    if (typeof current === 'string') return SECRET_PATTERNS.some((pattern) => pattern.test(current));
    if (typeof current !== 'object') return false;
    if (seen.has(current)) return false;
    seen.add(current);
    return Object.values(current).some((item) => visit(item));
  }

  return visit(value);
}

function hasUnresolvedPromptInjection(entry) {
  const reasons = asArray(entry.classification_reason || entry.classificationReason);
  const ext = entry._extensions || {};
  return entry.promptInjectionStatus === 'unresolved'
    || ext.promptInjectionStatus === 'unresolved'
    || reasons.some((reason) => /prompt.?injection|hostile|ignore_previous|role_directive/i.test(String(reason)));
}

function isRawExternalContent(entry) {
  const ext = entry._extensions || {};
  return entry.rawPrivateTelemetry === true
    || entry.rawExternalSourceText === true
    || ext.rawPrivateTelemetry === true
    || ext.rawExternalSourceText === true
    || entry.category === 'raw-private-telemetry'
    || entry.category === 'raw-external-source-text';
}

function isFeatureDenied(entry) {
  const ext = entry._extensions || {};
  return entry.localOnlyFeature === true
    || entry.localFeatureRunState === true
    || entry.category === 'local-feature-run'
    || ext.localOnlyFeature === true
    || ext.localFeatureRunState === true
    || (entry.category === 'feature-manifest' && ext.featureValidation !== 'validated');
}

function hasSemanticShellRisk(entry) {
  const ext = entry._extensions || {};
  return ext.publicationCritical === true
    || ext.claimIsOnlyInExtensions === true
    || (!entry.description && Boolean(ext.claim || ext.summary || ext.normalizedRecord));
}

function redactSource(source) {
  if (!source) return source;
  const text = String(source);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const parsed = new URL(text);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch (_) {
      return '[redacted-source-uri]';
    }
  }
  if (/[A-Z]:\\|^\/|\\/.test(text)) return '[redacted-local-path]';
  return text;
}

function buildPublicationPayload(entry, context = {}) {
  const payload = {};
  for (const field of PAYLOAD_ALLOWLIST) {
    if (entry[field] !== undefined) payload[field] = field === 'source' ? redactSource(entry[field]) : entry[field];
  }
  if (payload.projectId === undefined && context.publicationProjectId) {
    payload.projectId = context.publicationProjectId;
  }
  if (payload.content_hash === undefined) {
    payload.content_hash = canonicalSha256({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      status: entry.status,
      category: entry.category,
    });
  }
  return payload;
}

function auditEvent(entry, context, decision, reasons, payloadHash) {
  return {
    eventType: 'publication_attempt',
    runtimeMode: context.runtimeMode || 'recall-local',
    entryId: entry.id,
    projectId: entry.projectId || context.projectId || context.publicationProjectId || '',
    target: context.publicationTarget || 'meridian-signed-http-v1',
    policyDecision: decision,
    policyReasons: reasons,
    payloadHash,
    publisherKeyId: context.publisherKeyId || '',
    requestId: context.requestId || '',
  };
}

function evaluatePublicationPolicy(entry, context = {}) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('evaluatePublicationPolicy requires an entry object.');
  }

  const reasons = [];
  const partition = entry.partition || entry.partitionClaim || (entry._extensions && entry._extensions.partition);
  const trust = entry.source_trust_level || entry.sourceTrustLevel || (entry._extensions && entry._extensions.source_trust_level);
  const sourcePath = getSourcePath(entry);
  const dataRoot = context.dataRoot || process.env.MERIDIAN_DATA || '';

  if (entry.status === 'draft') reasons.push('status_draft');
  if (entry.status === 'retired') reasons.push('status_retired');
  if (partition === 'candidate_basin') reasons.push('partition_candidate_basin');
  if (partition === 'quarantine_basin') reasons.push('partition_quarantine_basin');
  if (partition === 'sensitive_vault') reasons.push('partition_sensitive_vault');
  if (trust === 'external_low') reasons.push('source_trust_external_low');
  if (trust === 'untrusted') reasons.push('source_trust_untrusted');
  if (containsSecretShapedValue(entry)) reasons.push('secret_shaped_value');
  if (hasUnresolvedPromptInjection(entry)) reasons.push('unresolved_prompt_injection');
  if (sourcePath && /(^|[\\/])\.recall([\\/]|$)/i.test(sourcePath)) reasons.push('adjacent_recall_source_path');
  if (sourcePath && dataRoot && !isWithin(dataRoot, sourcePath)) reasons.push('source_path_outside_data_root');
  if (entry.exportPipeline === true && !(entry.publicationApproval || (entry.provenance && entry.provenance.publicationApproval))) {
    reasons.push('export_without_publication_approval');
  }
  if (isRawExternalContent(entry)) reasons.push('raw_external_content');
  if (isFeatureDenied(entry)) reasons.push('local_or_unvalidated_feature');
  if (hasSemanticShellRisk(entry)) reasons.push('semantic_shell_after_allowlist');

  const payload = buildPublicationPayload(entry, context);
  const payloadHash = canonicalSha256(payload);
  const decision = reasons.length === 0 ? 'allow' : 'deny';

  return {
    decision,
    reasons,
    publicationClass: decision === 'allow' ? 'reviewed_entry' : 'denied',
    payloadAllowlist: PAYLOAD_ALLOWLIST.slice(),
    payload: decision === 'allow' ? payload : null,
    redactions: entry.source && payload.source !== entry.source ? ['source'] : [],
    auditEvent: auditEvent(entry, context, decision, reasons, payloadHash),
  };
}

module.exports = {
  PAYLOAD_ALLOWLIST,
  canonicalize,
  canonicalSha256,
  evaluatePublicationPolicy,
  buildPublicationPayload,
};
