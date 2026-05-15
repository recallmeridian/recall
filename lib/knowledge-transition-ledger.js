'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalSha256 } = require('./canonical-json');
const {
  KNOWLEDGE_STATES,
  validateLifecycleTransition,
} = require('./knowledge-lifecycle');
const { evaluatePromotionGate } = require('./promotion-gates');

const LEDGER_SCHEMA = 'knowledge_transition_ledger_record/v1';
const EVENT_SCHEMA = 'knowledge_transition_event/v1';

const TRUSTED_TARGETS = new Set([
  KNOWLEDGE_STATES.VALIDATED_KNOWLEDGE,
]);

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null && item !== '');
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function readKnowledgeTransitionLedger(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw.split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function originIsExternal(input = {}) {
  const origin = input.origin || input.source || {};
  const partition = input.partition || origin.partition || input.resource_partition || '';
  const trust = input.source_trust_level || origin.source_trust_level || origin.sourceTrustLevel || '';
  const sourceType = input.source_type || origin.source_type || origin.sourceType || '';
  return partition === 'candidate_basin'
    || partition === 'quarantine_basin'
    || trust === 'external_low'
    || trust === 'untrusted'
    || /^external|web|pdf|mcp|plugin/i.test(String(sourceType || ''));
}

function normalizeTransitionEvent(input = {}, context = {}) {
  const lifecycle = validateLifecycleTransition(input, context);
  const errors = [...lifecycle.errors];
  const signal = lifecycle.signal;
  const evidenceRefs = asArray(signal.evidenceRefs);
  const reasons = asArray(signal.reasons);
  const requestedAction = input.action || (TRUSTED_TARGETS.has(signal.to) ? 'promote' : 'transition');
  const gate = TRUSTED_TARGETS.has(signal.to) && input.entry
    ? evaluatePromotionGate(input.entry, {
      type: input.entryType || input.type,
      requestedPromotion: input.requestedPromotion,
    })
    : null;

  if (TRUSTED_TARGETS.has(signal.to) && reasons.length === 0) {
    errors.push('trusted_transition_requires_justification');
  }
  if (TRUSTED_TARGETS.has(signal.to) && originIsExternal(input) && !context.humanApproved) {
    errors.push('external_knowledge_requires_human_approval');
  }
  if (gate && !gate.allowed) {
    errors.push(...gate.missingEvidence.map((item) => `promotion_gate_missing:${item}`));
    if (gate.reasons.some((reason) => reason.includes('does not match'))) {
      errors.push('promotion_gate_mismatch');
    }
  }

  const status = errors.length ? 'blocked' : 'accepted';
  return {
    schemaVersion: EVENT_SCHEMA,
    eventType: 'knowledge_transition',
    eventId: input.eventId || canonicalSha256({
      artifactId: signal.artifactId,
      from: signal.from,
      to: signal.to,
      decidedAt: signal.decidedAt,
      actor: signal.actor,
    }).replace('sha256:', 'knowledge-transition-').slice(0, 48),
    artifactId: signal.artifactId,
    action: requestedAction,
    from: signal.from,
    to: signal.to,
    status,
    actor: signal.actor,
    decidedAt: signal.decidedAt,
    reasons,
    evidenceRefs,
    falsifiers: asArray(signal.falsifiers),
    approval: {
      humanApproved: Boolean(context.humanApproved || input.humanApproved),
      approverId: context.approverId || input.approverId || '',
      approvalRef: context.approvalRef || input.approvalRef || '',
    },
    source: {
      partition: input.partition || (input.origin && input.origin.partition) || '',
      source_trust_level: input.source_trust_level || (input.origin && (input.origin.source_trust_level || input.origin.sourceTrustLevel)) || '',
      source_type: input.source_type || (input.origin && (input.origin.source_type || input.origin.sourceType)) || '',
    },
    gate: gate ? {
      allowed: gate.allowed,
      entryType: gate.entryType,
      requestedPromotion: gate.requestedPromotion,
      allowedPromotion: gate.allowedPromotion,
      missingEvidence: gate.missingEvidence,
      reasons: gate.reasons,
    } : null,
    policy: {
      effect: status === 'accepted' ? 'record_transition' : 'block_transition',
      mayMutateKnowledge: status === 'accepted',
      requiresHumanApprovalForExternalPromotion: true,
      automaticExternalPromotionAllowed: false,
    },
    errors,
    researchGrounding: [
      'nist-ai-rmf-genai-profile',
      'owasp-llm-top10-2025',
      'memento-2025-memory-consolidation',
      'amem-2025-agentic-memory',
    ],
  };
}

function appendKnowledgeTransitionRecord(filePath, event, context = {}) {
  ensureParent(filePath);
  const existing = readKnowledgeTransitionLedger(filePath);
  const normalizedEvent = normalizeTransitionEvent(event, context);
  if (normalizedEvent.status !== 'accepted') {
    const err = new Error(`Knowledge transition blocked: ${normalizedEvent.errors.join(', ')}`);
    err.event = normalizedEvent;
    throw err;
  }
  const previousHash = existing.length ? existing[existing.length - 1].recordHash : null;
  const recordWithoutHash = {
    schemaVersion: LEDGER_SCHEMA,
    sequence: existing.length + 1,
    previousHash,
    recordedAt: context.now || new Date().toISOString(),
    actor: context.actor || normalizedEvent.actor,
    artifactId: normalizedEvent.artifactId,
    eventId: normalizedEvent.eventId,
    eventHash: canonicalSha256(normalizedEvent),
    event: normalizedEvent,
  };
  const record = {
    ...recordWithoutHash,
    recordHash: canonicalSha256(recordWithoutHash),
  };
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

function verifyKnowledgeTransitionLedger(filePath) {
  const records = readKnowledgeTransitionLedger(filePath);
  const errors = [];
  let previousHash = null;
  records.forEach((record, index) => {
    const expectedSequence = index + 1;
    if (!record || record.schemaVersion !== LEDGER_SCHEMA) {
      errors.push(`schema_mismatch:${expectedSequence}`);
      return;
    }
    if (record.sequence !== expectedSequence) errors.push(`sequence_mismatch:${expectedSequence}`);
    if ((record.previousHash || null) !== previousHash) errors.push(`previous_hash_mismatch:${expectedSequence}`);
    const { recordHash, ...withoutHash } = record;
    if (recordHash !== canonicalSha256(withoutHash)) errors.push(`record_hash_mismatch:${expectedSequence}`);
    if (record.eventHash !== canonicalSha256(record.event || {})) errors.push(`event_hash_mismatch:${expectedSequence}`);
    if (!record.event || record.event.schemaVersion !== EVENT_SCHEMA) errors.push(`event_schema_mismatch:${expectedSequence}`);
    previousHash = recordHash || null;
  });
  return {
    ok: errors.length === 0,
    count: records.length,
    lastHash: records.length ? records[records.length - 1].recordHash : null,
    errors,
  };
}

function historyForArtifact(filePath, artifactId) {
  return readKnowledgeTransitionLedger(filePath)
    .filter((record) => record.artifactId === artifactId || (record.event && record.event.artifactId === artifactId));
}

function buildRollbackPlan(filePath, artifactId, opts = {}) {
  const history = historyForArtifact(filePath, artifactId);
  const latest = history[history.length - 1];
  const targetState = opts.targetState || (latest && latest.event && latest.event.from) || KNOWLEDGE_STATES.CANDIDATE_BELIEF;
  return {
    schemaVersion: 'knowledge_rollback_plan/v1',
    artifactId,
    generatedAt: opts.now || new Date().toISOString(),
    canRollback: Boolean(latest),
    currentState: latest && latest.event ? latest.event.to : '',
    targetState,
    lastRecordHash: latest ? latest.recordHash : '',
    requiredAction: latest ? 'append_demotion_or_reopen_transition' : 'no_history',
    suggestedTransition: latest ? {
      artifactId,
      from: latest.event.to,
      to: targetState,
      reasons: asArray(opts.reasons || 'rollback_requested'),
      falsifiers: asArray(opts.falsifiers),
      evidenceRefs: asArray(opts.evidenceRefs),
    } : null,
    historyCount: history.length,
  };
}

module.exports = {
  EVENT_SCHEMA,
  LEDGER_SCHEMA,
  appendKnowledgeTransitionRecord,
  buildRollbackPlan,
  historyForArtifact,
  normalizeTransitionEvent,
  readKnowledgeTransitionLedger,
  verifyKnowledgeTransitionLedger,
};
