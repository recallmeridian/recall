'use strict';

const SECURITY_EVENT_SCHEMA_VERSION = 'security-event/v1';
const CLOUD_EVENT_SPEC_VERSION = '1.0';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function classifyEventType(event) {
  return event.eventType || event.type || 'audit_event';
}

function inferPolicyResult(eventType, event) {
  return event.policyDecision
    || event.decision
    || (eventType === 'quarantine_classification' ? 'quarantine' : '')
    || (eventType === 'candidate_classification' ? 'candidate' : '')
    || '';
}

function inferReasons(event) {
  return asArray(event.policyReasons || event.classifier_reason || event.reasons);
}

function inferResourceId(event, context) {
  return context.resourceId
    || event.resourceId
    || event.entryId
    || event.candidateId
    || event.content_hash
    || event.payloadHash
    || '';
}

function cloudEventId(event, context, resourceId, eventType) {
  return context.eventId
    || event.eventId
    || event.id
    || event.payloadHash
    || event.content_hash
    || `${eventType}:${resourceId || 'unknown'}`;
}

function cloudEventSource(context, event) {
  return context.source
    || event.cloudEventSource
    || event.sourceSystem
    || 'recall://local/security';
}

function cloudEventType(eventType) {
  return `dev.recall.security.${eventType}`;
}

function telemetryAttributes({
  event,
  context,
  eventType,
  projectId,
  partition,
  sourceTrustLevel,
  policyResult,
  reasons,
  resourceId,
}) {
  return {
    'event.name': eventType,
    'event.domain': 'recall.security',
    'user.id': context.userId || event.userId || '',
    'enduser.id': context.ownerId || event.ownerId || '',
    'code.namespace': context.codeNamespace || event.codeNamespace || '',
    'recall.project_id': projectId,
    'recall.resource_id': resourceId,
    'recall.partition': partition,
    'recall.source_trust_level': sourceTrustLevel,
    'recall.policy_result': policyResult,
    'recall.policy_reasons': reasons.join(','),
    'recall.actor': context.actor || event.actor || 'system',
    'recall.action': context.action || event.action || eventType,
  };
}

function normalizeSecurityEvent(event = {}, context = {}) {
  const eventType = classifyEventType(event);
  const policyResult = inferPolicyResult(eventType, event);
  const reasons = inferReasons(event);
  const resourceId = inferResourceId(event, context);
  const projectId = event.projectId || context.projectId || '';
  const partition = context.partition || event.partition || event.resource_partition || '';
  const sourceTrustLevel = context.source_trust_level
    || context.sourceTrustLevel
    || event.source_trust_level
    || event.sourceTrustLevel
    || '';
  const timestamp = event.timestamp || context.timestamp || new Date().toISOString();
  const id = cloudEventId(event, context, resourceId, eventType);
  const source = cloudEventSource(context, event);
  const type = cloudEventType(eventType);
  const subject = resourceId ? `resource/${resourceId}` : eventType;
  const attributes = telemetryAttributes({
    event,
    context,
    eventType,
    projectId,
    partition,
    sourceTrustLevel,
    policyResult,
    reasons,
    resourceId,
  });

  return {
    eventSchemaVersion: SECURITY_EVENT_SCHEMA_VERSION,
    specversion: CLOUD_EVENT_SPEC_VERSION,
    id,
    source,
    type,
    subject,
    time: timestamp,
    datacontenttype: 'application/json',
    eventType,
    timestamp,
    actor: context.actor || event.actor || 'system',
    action: context.action || event.action || eventType,
    resource: {
      id: resourceId,
      type: context.resourceType || event.resourceType || (event.entryId || event.candidateId ? 'entry' : 'content'),
      projectId,
      partition,
      source_trust_level: sourceTrustLevel,
    },
    partition,
    source_trust_level: sourceTrustLevel,
    policy: {
      result: policyResult,
      reasons,
    },
    policyResult,
    reasons,
    hashes: {
      content_hash: event.content_hash || event.contentHash || '',
      payloadHash: event.payloadHash || '',
    },
    sink: event.sink || context.sink || '',
    tool: event.tool || context.tool || '',
    attributes,
    details: event,
  };
}

function validateSecurityEvent(event) {
  const errors = [];
  if (!event || typeof event !== 'object') errors.push('event_must_be_object');
  if (event && event.eventSchemaVersion !== SECURITY_EVENT_SCHEMA_VERSION) errors.push('unsupported_security_event_schema');
  if (event && event.specversion !== CLOUD_EVENT_SPEC_VERSION) errors.push('unsupported_cloudevents_specversion');
  if (event && !event.id) errors.push('cloudevents_id_required');
  if (event && !event.source) errors.push('cloudevents_source_required');
  if (event && !event.type) errors.push('cloudevents_type_required');
  if (event && !event.eventType) errors.push('event_type_required');
  if (event && !event.timestamp) errors.push('timestamp_required');
  if (event && (!event.resource || !event.resource.id)) errors.push('resource_id_required');
  if (event && (!event.policy || !event.policy.result)) errors.push('policy_result_required');
  return {
    ok: errors.length === 0,
    errors,
  };
}

module.exports = {
  CLOUD_EVENT_SPEC_VERSION,
  SECURITY_EVENT_SCHEMA_VERSION,
  normalizeSecurityEvent,
  validateSecurityEvent,
};
