'use strict';

const path = require('path');
const { appendAuditEvent } = require('./audit-sediment');
const { buildPublicationEnvelope } = require('./publication-envelope');
const { evaluatePublicationPolicy } = require('./publication-policy');

function defaultAuditPath(dataDir) {
  return path.join(dataDir, 'audit-sediment.jsonl');
}

function buildPublicationContext(project, options = {}) {
  return {
    runtimeMode: 'recall-local',
    dataRoot: options.dataRoot || '',
    projectId: project,
    publicationProjectId: options.publicationProjectId || project,
    publicationTarget: options.publicationTarget || 'meridian-signed-http-v1',
    publisherKeyId: options.publisherKeyId || '',
    requestId: options.requestId || '',
  };
}

async function evaluatePushEntry(entry, project, options = {}) {
  const context = buildPublicationContext(project, options);
  const policy = evaluatePublicationPolicy(entry, context);
  const envelope = await buildPublicationEnvelope(policy, entry, context, options.signingService);
  return {
    entryId: entry.id,
    project,
    decision: policy.decision,
    reasons: policy.reasons,
    payload: policy.payload,
    envelope,
    envelopeHash: envelope ? envelope.publicationId : '',
    payloadHash: policy.auditEvent.payloadHash,
    auditEvent: policy.auditEvent,
  };
}

async function recordDryRunPush(entry, project, options = {}) {
  const auditPath = options.auditPath || (options.dataRoot ? defaultAuditPath(options.dataRoot) : '');

  if (!auditPath) {
    throw new Error('recordDryRunPush requires options.auditPath or options.dataRoot so dry-run publication decisions are audited.');
  }

  const result = await evaluatePushEntry(entry, project, options);

  result.auditRecord = appendAuditEvent(auditPath, result.auditEvent, {
    actor: options.actor || 'push-command',
    action: 'dry_run_publication_policy',
    resourceId: entry.id,
    resourceType: 'entry',
    projectId: project,
    partition: entry.partition || entry.partitionClaim || (entry._extensions && entry._extensions.partition) || '',
  });

  return result;
}

module.exports = {
  buildPublicationContext,
  defaultAuditPath,
  evaluatePushEntry,
  recordDryRunPush,
};
