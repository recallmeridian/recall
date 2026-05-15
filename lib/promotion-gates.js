'use strict';

const GROUNDING_REFS = [
  'trace2skill-2026-transferable-agent-skills',
  'alphaproof-2025-formal-math-rl',
  'funsearch-2023-program-search',
  'agarwal-2025-persuasion-overrides-truth',
  'lemmabench-2026-live-research-level-math',
];

const GATE_POLICIES = {
  paper: {
    requiredEvidence: ['source_ref', 'human_review'],
    allowedPromotion: 'trusted_reference',
  },
  trace: {
    requiredEvidence: ['source_trace', 'outcome_link'],
    allowedPromotion: 'candidate_evidence',
  },
  lesson: {
    requiredEvidence: ['source_trace', 'outcome_evidence'],
    allowedPromotion: 'candidate_lesson',
  },
  skill: {
    requiredEvidence: ['source_trace', 'evaluation_evidence'],
    allowedPromotion: 'validated_skill',
  },
  verifier_result: {
    requiredEvidence: ['formal_statement', 'verifier_run', 'proof_artifact'],
    allowedPromotion: 'verified_claim',
  },
  debate: {
    requiredEvidence: ['source_pack', 'baseline_comparison', 'judge_risk_check', 'external_verification'],
    allowedPromotion: 'decision_evidence',
  },
  benchmark_result: {
    requiredEvidence: ['benchmark_task', 'baseline', 'run_result', 'contamination_check'],
    allowedPromotion: 'evaluation_evidence',
  },
  evaluator_candidate: {
    requiredEvidence: ['candidate_program', 'evaluator_run', 'score', 'lineage'],
    allowedPromotion: 'scored_candidate',
  },
};

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null);
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function evidenceTypes(entry = {}) {
  const ext = entry._extensions || entry;
  return new Set([
    ...asArray(entry.evidenceTypes),
    ...asArray(ext.evidenceTypes),
    ...asArray(entry.evidenceRefs).map((ref) => ref.evidenceType || ref.type || ref.evidenceClass).filter(Boolean),
    ...asArray(ext.evidenceRefs).map((ref) => ref.evidenceType || ref.type || ref.evidenceClass).filter(Boolean),
  ]);
}

function inferEntryType(entry = {}, explicitType = '') {
  if (explicitType) return explicitType;
  const ext = entry._extensions || {};
  return ext.promotionGateType
    || ext.researchType
    || ext.brainstormingType
    || entry.entryType
    || entry.category
    || '';
}

function normalizeType(type) {
  const text = String(type || '').toLowerCase().replace(/[-\s]+/g, '_');
  if (text === 'research_attempt') return 'trace';
  if (text === 'brainstorming_artifact' || text === 'raw_deliberation') return 'debate';
  if (text === 'skill_candidate') return 'skill';
  return text;
}

function evaluatePromotionGate(entry = {}, opts = {}) {
  const entryType = normalizeType(inferEntryType(entry, opts.type));
  const policy = GATE_POLICIES[entryType];
  if (!policy) {
    return {
      allowed: false,
      entryType,
      requestedPromotion: opts.requestedPromotion || '',
      allowedPromotion: '',
      missingEvidence: ['explicit_entry_type'],
      reasons: [entryType
        ? `No promotion gate policy exists for entry type "${entryType}".`
        : 'Promotion gate requires an explicit entry type.'],
      groundingRefs: GROUNDING_REFS,
    };
  }

  const available = evidenceTypes(entry);
  const missingEvidence = policy.requiredEvidence.filter((type) => !available.has(type));
  const entryPromotion = entry.promotionDecision || (entry._extensions && entry._extensions.promotionDecision) || '';
  const requestedPromotion = opts.requestedPromotion
    || (entryPromotion === 'blocked_pending_evaluation' ? '' : entryPromotion)
    || policy.allowedPromotion;
  const wrongPromotion = requestedPromotion && requestedPromotion !== policy.allowedPromotion;
  const allowed = missingEvidence.length === 0 && !wrongPromotion;

  return {
    allowed,
    entryType,
    requestedPromotion,
    allowedPromotion: policy.allowedPromotion,
    requiredEvidence: policy.requiredEvidence,
    presentEvidence: Array.from(available).sort(),
    missingEvidence,
    reasons: [
      ...missingEvidence.map((type) => `Missing required evidence: ${type}`),
      ...(wrongPromotion ? [`Requested promotion "${requestedPromotion}" does not match allowed promotion "${policy.allowedPromotion}".`] : []),
    ],
    groundingRefs: GROUNDING_REFS,
  };
}

module.exports = {
  GROUNDING_REFS,
  GATE_POLICIES,
  evaluatePromotionGate,
};
