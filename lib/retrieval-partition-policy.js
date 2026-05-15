'use strict';

const { spotlightRetrievedCandidate } = require('./context-spotlighting');
const { canonicalSha256 } = require('./canonical-json');
const { appendRetrievalReconsolidationRecord } = require('./retrieval-reconsolidation-ledger');

const RECONSOLIDATION_SCHEMA = 'retrieval_reconsolidation_candidate/v1';

const PARTITIONS = {
  TRUSTED: 'trusted_kb',
  CANDIDATE: 'candidate_basin',
  QUARANTINE: 'quarantine_basin',
  SENSITIVE: 'sensitive_vault',
};

const MODES = {
  NORMAL: 'normal',
  ALL: '*',
  TRUSTED: 'trusted',
  CANDIDATE: 'candidate',
  QUARANTINE: 'quarantine',
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeRetrievalMode(value) {
  const mode = String(value || MODES.NORMAL).toLowerCase();
  if (mode === 'from *' || mode === 'all') return MODES.ALL;
  if (mode === 'from trusted') return MODES.TRUSTED;
  if (mode === 'from candidate') return MODES.CANDIDATE;
  if (mode === 'from quarantine') return MODES.QUARANTINE;
  return mode;
}

function normalizeRetrievalCandidate(candidate = {}) {
  const ext = candidate._extensions || {};
  const partition = candidate.partition
    || candidate.resource_partition
    || candidate.partitionClaim
    || ext.partition
    || PARTITIONS.TRUSTED;
  const sourceTrustLevel = candidate.source_trust_level
    || candidate.sourceTrustLevel
    || ext.source_trust_level
    || (partition === PARTITIONS.TRUSTED ? 'trusted' : 'external_low');

  return {
    ...candidate,
    id: candidate.id || candidate.entry_id || candidate.entryId || '',
    projectId: candidate.projectId || candidate.project_id || '',
    partition,
    source_trust_level: sourceTrustLevel,
    allowed_retrieval_modes: asArray(
      candidate.allowed_retrieval_modes
      || candidate.allowedRetrievalModes
      || ext.allowed_retrieval_modes,
    ),
  };
}

function candidateText(candidate) {
  return candidate.text || candidate.content || candidate.description || candidate.name || '';
}

function safeIso(value) {
  return value || new Date().toISOString();
}

function queryFingerprint(queryContext = {}) {
  const query = String(queryContext.query || '');
  return {
    queryHash: query ? canonicalSha256({ query }) : '',
    queryLength: query.length,
  };
}

function sourceProjectOf(candidate = {}) {
  const ext = candidate._extensions || {};
  return candidate.source_project_id
    || candidate.sourceProjectId
    || ext.source_project_id
    || ext.sourceProjectId
    || '';
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
  return [
    '_score',
    '_semanticScore',
    '_hybridScore',
    '_tfidfScore',
    '_relevanceScore',
    '_overlapScore',
  ].reduce((scores, key) => {
    if (typeof candidate[key] === 'number') scores[key.replace(/^_/, '')] = candidate[key];
    return scores;
  }, {});
}

function proposedEffectsFor(candidate, retrievalDecision) {
  const effects = ['observe_retrieval'];
  if (retrievalDecision === 'allow') effects.push('candidate_retrieval_count_increment');
  if (retrievalDecision === 'allow') effects.push('candidate_last_retrieved_at_update');
  if (candidate.partition !== PARTITIONS.TRUSTED || candidate.source_trust_level !== 'trusted') {
    effects.push('candidate_review_signal');
  }
  const sourceProjectId = sourceProjectOf(candidate);
  if (candidate.projectId && sourceProjectId && candidate.projectId !== sourceProjectId) {
    effects.push('cross_project_bridge_candidate');
  }
  return effects;
}

function reconsolidationEventId(shape) {
  return canonicalSha256(shape).replace('sha256:', 'retrieval-reconsolidation-').slice(0, 48);
}

function buildLocalRetrievalReconsolidationEvent(input = {}) {
  const candidate = normalizeRetrievalCandidate(input.candidate || {});
  const queryContext = input.queryContext || {};
  const generatedAt = safeIso(input.generatedAt || queryContext.now);
  const retrievalMode = normalizeRetrievalMode(queryContext.from || queryContext.retrievalMode || queryContext.mode);
  const retrievalDecision = input.retrievalDecision || 'allow';
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
    eventId: input.eventId || reconsolidationEventId(eventShape),
    eventType: 'retrieval_reconsolidation_candidate',
    actor: input.actor || 'recall.retrieval',
    query: fingerprint,
    candidate: {
      id: candidate.id,
      projectId: candidate.projectId || queryContext.projectId || '',
      sourceProjectId: sourceProjectOf(candidate),
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

function canRetrieveCandidate(candidate, queryContext = {}) {
  const normalized = normalizeRetrievalCandidate(candidate);
  const mode = normalizeRetrievalMode(queryContext.retrievalMode || queryContext.from || queryContext.mode);
  const reasons = [];

  if (normalized.partition === PARTITIONS.SENSITIVE) {
    reasons.push('partition_sensitive_vault_never_retrievable');
  }

  if (mode === MODES.NORMAL || mode === MODES.TRUSTED) {
    if (normalized.partition !== PARTITIONS.TRUSTED) {
      reasons.push('normal_retrieval_requires_trusted_partition');
    }
  } else if (mode === MODES.ALL) {
    if (normalized.partition === PARTITIONS.QUARANTINE) reasons.push('from_star_excludes_quarantine');
    if (normalized.partition === PARTITIONS.SENSITIVE) reasons.push('from_star_excludes_sensitive_vault');
  } else if (mode === MODES.CANDIDATE) {
    if (normalized.partition !== PARTITIONS.CANDIDATE) reasons.push('explicit_candidate_requires_candidate_partition');
  } else if (mode === MODES.QUARANTINE) {
    if (normalized.partition !== PARTITIONS.QUARANTINE) reasons.push('explicit_quarantine_requires_quarantine_partition');
    if (!queryContext.allowQuarantine) reasons.push('explicit_quarantine_requires_allow_quarantine_flag');
  } else {
    reasons.push('unknown_retrieval_mode');
  }

  if (normalized.allowed_retrieval_modes.length > 0) {
    const allowed = normalized.allowed_retrieval_modes.map(normalizeRetrievalMode);
    if (!allowed.includes(mode)) reasons.push('candidate_allowed_modes_exclude_query_mode');
  }

  const decision = reasons.length === 0 ? 'allow' : 'deny';
  return {
    decision,
    reasons: decision === 'allow' ? ['retrieval_partition_allowed'] : reasons,
    candidate: normalized,
    auditEvent: {
      eventType: 'retrieval_partition_check',
      candidateId: normalized.id,
      projectId: normalized.projectId,
      partition: normalized.partition,
      source_trust_level: normalized.source_trust_level,
      retrievalMode: mode,
      policyDecision: decision,
      policyReasons: decision === 'allow' ? ['retrieval_partition_allowed'] : reasons,
    },
  };
}

function filterRetrievalCandidates(candidates, queryContext = {}) {
  const decisions = asArray(candidates).map((candidate) => canRetrieveCandidate(candidate, queryContext));
  return {
    candidates: decisions
      .filter((result) => result.decision === 'allow')
      .map((result) => result.candidate),
    denied: decisions.filter((result) => result.decision === 'deny'),
    auditEvents: decisions.map((result) => result.auditEvent),
  };
}

function candidateNeedsSpotlighting(candidate) {
  return candidate.partition !== PARTITIONS.TRUSTED || candidate.source_trust_level !== 'trusted';
}

function buildRetrievalContext(candidates, queryContext = {}) {
  const filtered = filterRetrievalCandidates(candidates, queryContext);
  const contextItems = filtered.candidates.map((candidate) => {
    if (candidateNeedsSpotlighting(candidate)) {
      return {
        candidateId: candidate.id,
        partition: candidate.partition,
        source_trust_level: candidate.source_trust_level,
        context: spotlightRetrievedCandidate(candidate, queryContext.spotlighting || {}),
      };
    }

    return {
      candidateId: candidate.id,
      partition: candidate.partition,
      source_trust_level: candidate.source_trust_level,
      context: {
        kind: 'trusted_retrieval_data',
        wrapped: candidateText(candidate),
        metadata: {
          entry_id: candidate.id,
          project_id: candidate.projectId,
          partition: candidate.partition,
          source_trust_level: candidate.source_trust_level,
        },
      },
    };
  });
  const allowedEvents = filtered.candidates.map((candidate, index) => buildLocalRetrievalReconsolidationEvent({
    candidate,
    queryContext,
    generatedAt: queryContext.now,
    retrievalId: queryContext.retrievalId,
    rank: index + 1,
    retrievalDecision: 'allow',
    contextTreatment: candidateNeedsSpotlighting(candidate) ? 'spotlighted_untrusted_data' : 'trusted_raw',
  }));
  const deniedEvents = filtered.denied.map((decision, index) => buildLocalRetrievalReconsolidationEvent({
    candidate: decision.candidate,
    queryContext,
    generatedAt: queryContext.now,
    retrievalId: queryContext.retrievalId,
    rank: allowedEvents.length + index + 1,
    retrievalDecision: 'deny',
    contextTreatment: 'excluded_from_context',
    reasons: decision.reasons,
  }));
  const reconsolidationEvents = [...allowedEvents, ...deniedEvents];
  const reconsolidationLedger = {
    attempted: false,
    path: queryContext.reconsolidationLedgerPath || '',
    appended: 0,
    errors: [],
    recordHashes: [],
  };

  if (queryContext.reconsolidationLedgerPath) {
    reconsolidationLedger.attempted = true;
    for (const event of reconsolidationEvents) {
      try {
        const record = appendRetrievalReconsolidationRecord(queryContext.reconsolidationLedgerPath, event, {
          actor: queryContext.actor || 'retrieval-partition-policy',
          projectId: queryContext.projectId || event.projectId,
          now: queryContext.now,
        });
        reconsolidationLedger.appended += 1;
        reconsolidationLedger.recordHashes.push(record.recordHash);
      } catch (err) {
        reconsolidationLedger.errors.push({
          eventId: event.eventId,
          message: err.message,
        });
      }
    }
  }

  return {
    ...filtered,
    contextItems,
    reconsolidationEvents,
    reconsolidationLedger,
  };
}

module.exports = {
  MODES,
  PARTITIONS,
  buildRetrievalContext,
  canRetrieveCandidate,
  filterRetrievalCandidates,
  normalizeRetrievalCandidate,
};
