'use strict';

const KNOWLEDGE_STATES = {
  RAW_OBSERVATION: 'raw_observation',
  CANDIDATE_BELIEF: 'candidate_belief',
  VALIDATED_KNOWLEDGE: 'validated_knowledge',
  CONTRADICTED: 'contradicted',
  SUPERSEDED: 'superseded',
  RETIRED: 'retired',
  REOPENED: 'reopened',
};

const TRANSITIONS = {
  [KNOWLEDGE_STATES.RAW_OBSERVATION]: [
    KNOWLEDGE_STATES.CANDIDATE_BELIEF,
    KNOWLEDGE_STATES.RETIRED,
  ],
  [KNOWLEDGE_STATES.CANDIDATE_BELIEF]: [
    KNOWLEDGE_STATES.VALIDATED_KNOWLEDGE,
    KNOWLEDGE_STATES.CONTRADICTED,
    KNOWLEDGE_STATES.SUPERSEDED,
    KNOWLEDGE_STATES.RETIRED,
  ],
  [KNOWLEDGE_STATES.VALIDATED_KNOWLEDGE]: [
    KNOWLEDGE_STATES.CONTRADICTED,
    KNOWLEDGE_STATES.SUPERSEDED,
    KNOWLEDGE_STATES.RETIRED,
  ],
  [KNOWLEDGE_STATES.CONTRADICTED]: [
    KNOWLEDGE_STATES.REOPENED,
    KNOWLEDGE_STATES.RETIRED,
  ],
  [KNOWLEDGE_STATES.SUPERSEDED]: [
    KNOWLEDGE_STATES.REOPENED,
    KNOWLEDGE_STATES.RETIRED,
  ],
  [KNOWLEDGE_STATES.REOPENED]: [
    KNOWLEDGE_STATES.CANDIDATE_BELIEF,
    KNOWLEDGE_STATES.RETIRED,
  ],
  [KNOWLEDGE_STATES.RETIRED]: [
    KNOWLEDGE_STATES.REOPENED,
  ],
};

const FALSIFIER_STATES = new Set([
  KNOWLEDGE_STATES.CONTRADICTED,
  KNOWLEDGE_STATES.SUPERSEDED,
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function knownState(state) {
  return Object.values(KNOWLEDGE_STATES).includes(state);
}

function allowedTransition(from, to) {
  return asArray(TRANSITIONS[from]).includes(to);
}

function normalizeLifecycleSignal(input = {}, context = {}) {
  const from = input.from || input.fromState || '';
  const to = input.to || input.toState || '';
  const reasons = asArray(input.reasons || input.reason);
  const falsifiers = asArray(input.falsifiers || input.falsifier || input.refutationCriteria);
  const evidenceRefs = asArray(input.evidenceRefs || input.evidence || input.sourceRefs);

  return {
    artifactId: input.artifactId || input.entryId || input.resourceId || '',
    from,
    to,
    reasons,
    falsifiers,
    evidenceRefs,
    actor: context.actor || input.actor || 'system',
    decidedAt: context.now || context.timestamp || input.decidedAt || new Date().toISOString(),
  };
}

function validateLifecycleTransition(input = {}, context = {}) {
  const signal = normalizeLifecycleSignal(input, context);
  const errors = [];

  if (!signal.artifactId) errors.push('artifact_id_required');
  if (!knownState(signal.from)) errors.push('unknown_from_state');
  if (!knownState(signal.to)) errors.push('unknown_to_state');
  if (knownState(signal.from) && knownState(signal.to) && !allowedTransition(signal.from, signal.to)) {
    errors.push('transition_not_allowed');
  }
  if (signal.to === KNOWLEDGE_STATES.VALIDATED_KNOWLEDGE && signal.evidenceRefs.length === 0) {
    errors.push('validation_requires_evidence');
  }
  if (FALSIFIER_STATES.has(signal.to) && signal.falsifiers.length === 0) {
    errors.push('falsifier_required');
  }
  if (signal.to === KNOWLEDGE_STATES.RETIRED && signal.reasons.length === 0) {
    errors.push('retirement_requires_reason');
  }

  return {
    ok: errors.length === 0,
    errors,
    signal,
  };
}

module.exports = {
  KNOWLEDGE_STATES,
  TRANSITIONS,
  normalizeLifecycleSignal,
  validateLifecycleTransition,
};
