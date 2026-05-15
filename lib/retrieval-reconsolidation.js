'use strict';

const { canonicalSha256 } = require('./canonical-json');
const { normalizeRetrievalCandidate } = require('./retrieval-partition-policy');

const RECONSOLIDATION_SCHEMA = 'retrieval_reconsolidation_candidate/v1';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeIso(value) {
  return value || new Date().toISOString();
}

function normalizeRetrievalMode(queryContext = {}) {
  return String(queryContext.from || queryContext.retrievalMode || queryContext.mode || 'normal').toLowerCase();
}

function queryFingerprint(queryContext = {}) {
  const query = String(queryContext.query || '');
  return {
    queryHash: query ? canonicalSha256({ query }) : '',
    queryLength: query.length,
  };
}

function candidateLifecycle(candidate = {}) {
  const ext = candidate._extensions || {};
  return candidate.lifecycle
    || candidate.lifecycle_state
    || candidate.lifecycleState
    || candidate.status
    || ext.lifecycle
    || 'unknown';
}

function scoreSummary(candidate = {}) {
  const scoreFields = [
    '_score',
    '_semanticScore',
    '_hybridScore',
    '_tfidfScore',
    '_relevanceScore',
    '_overlapScore',
  ];
  return scoreFields.reduce((scores, key) => {
    if (typeof candidate[key] === 'number') scores[key.replace(/^_/, '')] = candidate[key];
    return scores;
  }, {});
}

function sourceProjectOf(candidate = {}) {
  const ext = candidate._extensions || {};
  return candidate.source_project_id
    || candidate.sourceProjectId
    || ext.source_project_id
    || ext.sourceProjectId
    || '';
}

function proposedEffectsFor(candidate, retrievalDecision) {
  const effects = ['observe_retrieval'];
  if (retrievalDecision === 'allow') effects.push('candidate_retrieval_count_increment');
  if (retrievalDecision === 'allow') effects.push('candidate_last_retrieved_at_update');
  if (candidate.partition !== 'trusted_kb' || candidate.source_trust_level !== 'trusted') {
    effects.push('candidate_review_signal');
  }
  const sourceProjectId = sourceProjectOf(candidate);
  if (candidate.projectId && sourceProjectId && candidate.projectId !== sourceProjectId) {
    effects.push('cross_project_bridge_candidate');
  }
  return effects;
}

function eventIdFor(shape) {
  return canonicalSha256(shape).replace('sha256:', 'retrieval-reconsolidation-').slice(0, 48);
}

function buildRetrievalReconsolidationEvent(input = {}) {
  const candidate = normalizeRetrievalCandidate(input.candidate || {});
  const queryContext = input.queryContext || {};
  const generatedAt = safeIso(input.generatedAt || queryContext.now);
  const retrievalMode = normalizeRetrievalMode(queryContext);
  const retrievalDecision = input.retrievalDecision || input.decision || 'allow';
  const rank = Number.isInteger(input.rank) ? input.rank : 0;
  const fingerprint = queryFingerprint(queryContext);
  const retrievalId = input.retrievalId || canonicalSha256({
    projectId: queryContext.projectId || candidate.projectId || '',
    retrievalMode,
    queryHash: fingerprint.queryHash,
    generatedAt,
  }).replace('sha256:', 'retrieval-').slice(0, 30);
  const eventShape = {
    schemaVersion: RECONSOLIDATION_SCHEMA,
    retrievalId,
    candidateId: candidate.id,
    projectId: candidate.projectId || queryContext.projectId || '',
    retrievalMode,
    retrievalDecision,
    rank,
    generatedAt,
  };

  return {
    ...eventShape,
    eventId: input.eventId || eventIdFor(eventShape),
    eventType: 'retrieval_reconsolidation_candidate',
    actor: input.actor || 'recall.retrieval',
    query: fingerprint,
    candidate: {
      id: candidate.id,
      projectId: candidate.projectId || queryContext.projectId || '',
      sourceProjectId: sourceProjectOf(input.candidate || candidate),
      partition: candidate.partition,
      source_trust_level: candidate.source_trust_level,
      lifecycle: candidateLifecycle(candidate),
      scores: scoreSummary(input.candidate || candidate),
    },
    observation: {
      contextTreatment: input.contextTreatment || '',
      reasons: asArray(input.reasons),
      retrieved: retrievalDecision === 'allow',
    },
    proposedEffects: proposedEffectsFor(candidate, retrievalDecision),
    policy: {
      effect: 'report_only',
      mayMutateMemory: false,
      mayChangeRanking: false,
      requiresPromotionBeforeMutation: true,
    },
    researchGrounding: [
      'memorygraft-2025-poisoned-experience-retrieval',
      'behavioral-immune-layer-ai-defense-2026',
      'nist-ai-rmf-genai-profile',
    ],
  };
}

function buildRetrievalReconsolidationBatch(input = {}) {
  const allowed = asArray(input.allowed).map((candidate, index) => buildRetrievalReconsolidationEvent({
    candidate,
    queryContext: input.queryContext,
    generatedAt: input.generatedAt,
    retrievalId: input.retrievalId,
    rank: index + 1,
    retrievalDecision: 'allow',
    contextTreatment: candidate.partition === 'trusted_kb' && candidate.source_trust_level === 'trusted'
      ? 'trusted_raw'
      : 'spotlighted_untrusted_data',
  }));
  const denied = asArray(input.denied).map((decision, index) => buildRetrievalReconsolidationEvent({
    candidate: decision.candidate || decision,
    queryContext: input.queryContext,
    generatedAt: input.generatedAt,
    retrievalId: input.retrievalId,
    rank: allowed.length + index + 1,
    retrievalDecision: 'deny',
    contextTreatment: 'excluded_from_context',
    reasons: decision.reasons,
  }));

  return {
    schemaVersion: 'retrieval_reconsolidation_batch/v1',
    retrievalId: (allowed[0] && allowed[0].retrievalId) || (denied[0] && denied[0].retrievalId) || '',
    query: queryFingerprint(input.queryContext || {}),
    events: [...allowed, ...denied],
  };
}

function consumeRetrievalReconsolidationCandidates(events = []) {
  const summary = {
    schemaVersion: 'retrieval_reconsolidation_consumer_summary/v1',
    eventCount: 0,
    parseableCount: 0,
    reportOnlyCount: 0,
    byPartition: {},
    byDecision: {},
    proposedEffects: {},
    errors: [],
  };

  for (const event of asArray(events)) {
    summary.eventCount += 1;
    if (!event || event.schemaVersion !== RECONSOLIDATION_SCHEMA || !event.eventId || !event.candidate) {
      summary.errors.push(`invalid_event:${summary.eventCount}`);
      continue;
    }
    summary.parseableCount += 1;
    if (event.policy && event.policy.effect === 'report_only' && event.policy.mayMutateMemory === false) {
      summary.reportOnlyCount += 1;
    }
    const partition = event.candidate.partition || 'unknown';
    const decision = event.retrievalDecision || 'unknown';
    summary.byPartition[partition] = (summary.byPartition[partition] || 0) + 1;
    summary.byDecision[decision] = (summary.byDecision[decision] || 0) + 1;
    for (const effect of asArray(event.proposedEffects)) {
      summary.proposedEffects[effect] = (summary.proposedEffects[effect] || 0) + 1;
    }
  }

  summary.ok = summary.errors.length === 0 && summary.parseableCount === summary.eventCount;
  return summary;
}

module.exports = {
  RECONSOLIDATION_SCHEMA,
  buildRetrievalReconsolidationBatch,
  buildRetrievalReconsolidationEvent,
  consumeRetrievalReconsolidationCandidates,
};
