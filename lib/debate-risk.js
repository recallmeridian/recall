'use strict';

const fs = require('fs');
const path = require('path');

const GROUNDING_REFS = [
  'irving-2018-ai-safety-via-debate',
  'du-2024-multiagent-debate-factuality',
  'khan-2024-persuasive-debate-truthfulness',
  'agarwal-2025-persuasion-overrides-truth',
  'smit-2024-should-we-be-going-mad',
  'sparse-communication-debate-2024',
];

const TOPOLOGIES = new Set([
  'single_judge',
  'cross_examination',
  'multi_agent',
  'full_mesh',
  'sparse',
  'ensemble',
]);
const DENSE_TOPOLOGIES = new Set(['cross_examination', 'multi_agent', 'full_mesh', 'ensemble']);
const EXTERNAL_VERIFICATION_TYPES = new Set([
  'verifier_result',
  'formal_verifier',
  'benchmark_result',
  'evaluator_run',
  'human_review',
  'ensemble_review',
]);
const SAME_MODEL_BACKING_TYPES = new Set(['verifier_result', 'formal_verifier', 'human_review', 'ensemble_review']);

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null);
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function normalizeFamily(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function normalizeType(value) {
  return String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
}

function hasFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function hasAddressableRef(value) {
  const ref = String(value || '').trim();
  return Boolean(ref && (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref) || /^[a-z][a-z0-9+.-]*:/i.test(ref)));
}

function resolveLocalRef(ref, baseDir = '') {
  const text = String(ref || '').trim();
  if (!text || hasAddressableRef(text)) return Boolean(text);
  if (!baseDir) return false;
  const resolved = path.resolve(baseDir, text);
  return fs.existsSync(resolved);
}

function hasBaselineComparison(value) {
  if (!value || typeof value !== 'object') return false;
  if (!hasAddressableRef(value.baselineRunRef || value.evidenceRef || value.ref)) return false;
  if (hasFiniteNumber(value.delta)) return true;
  return hasFiniteNumber(value.baselineScore) && hasFiniteNumber(value.debateScore);
}

function baselineDelta(value) {
  if (!value || typeof value !== 'object') return 0;
  if (hasFiniteNumber(value.delta)) return Number(value.delta);
  if (hasFiniteNumber(value.baselineScore) && hasFiniteNumber(value.debateScore)) {
    return Number(value.debateScore) - Number(value.baselineScore);
  }
  return 0;
}

function verificationType(value) {
  if (!value || typeof value !== 'object') return '';
  return normalizeType(value.type || value.evidenceType || value.verificationType);
}

function hasVerificationReference(value) {
  if (!value || typeof value !== 'object') return false;
  return hasAddressableRef(value.evidenceRef || value.ref || value.reviewerRef || value.verifierRef || value.ensembleRef);
}

function hasExternalVerification(value) {
  const type = verificationType(value);
  return EXTERNAL_VERIFICATION_TYPES.has(type) && hasVerificationReference(value);
}

function validateDebateArtifact(input = {}, opts = {}) {
  const protocol = input.judgeProtocol || input.protocol || 'unknown';
  const topology = input.topology || 'single_judge';
  const judgeFamily = normalizeFamily(input.judgeModelFamily || input.judgeFamily || input.judge);
  const participantFamilies = asArray(input.participantModelFamilies || input.participants).map(normalizeFamily).filter(Boolean);
  const baselineComparison = input.baselineComparison || null;
  const externalVerification = input.externalVerification || null;
  const sourcePack = input.sourcePack || input.sourcePackRef || null;
  const cost = input.cost || {};
  const issues = [];
  const riskFlags = [];

  if (!TOPOLOGIES.has(topology)) issues.push('unknown_topology');
  if (!resolveLocalRef(sourcePack, opts.baseDir || '')) issues.push('missing_source_pack');
  if (participantFamilies.length === 0) issues.push('missing_participant_model_families');
  if (!hasBaselineComparison(baselineComparison)) issues.push('missing_baseline_comparison');
  if (!externalVerification) {
    issues.push('missing_external_verification');
  } else if (!hasExternalVerification(externalVerification)) {
    issues.push('invalid_external_verification');
  }
  if (!judgeFamily) issues.push('missing_judge_model_family');

  const sameModelJudge = Boolean(
    (judgeFamily && participantFamilies.length === 0)
      || (judgeFamily && participantFamilies.includes(judgeFamily))
      || normalizeType(protocol) === 'same_model_judge'
      || input.sameModelJudge === true
  );
  if (sameModelJudge) {
    riskFlags.push('same_model_judge');
    if (!SAME_MODEL_BACKING_TYPES.has(verificationType(externalVerification))) {
      issues.push('same_model_judge_requires_external_verification');
    }
  }

  const persuasionRisk = sameModelJudge || normalizeType(input.persuasionRisk) === 'high' ? 'high' : normalizeType(input.persuasionRisk) || 'medium';
  if (persuasionRisk === 'high') riskFlags.push('persuasion_risk_high');
  if (hasBaselineComparison(baselineComparison) && baselineDelta(baselineComparison) < 0) {
    issues.push('debate_underperforms_baseline');
  }
  if (hasBaselineComparison(baselineComparison) && baselineDelta(baselineComparison) === 0 && verificationType(externalVerification) !== 'verifier_result' && verificationType(externalVerification) !== 'formal_verifier') {
    issues.push('debate_no_baseline_improvement');
  }
  if (persuasionRisk === 'high' && !SAME_MODEL_BACKING_TYPES.has(verificationType(externalVerification))) {
    issues.push('high_persuasion_risk_requires_external_backing');
  }
  if (DENSE_TOPOLOGIES.has(topology)) {
    if (!hasFiniteNumber(cost.turnCount) || (!hasFiniteNumber(cost.maxTurns) && !cost.costCap)) {
      issues.push('cost_cap_required_for_dense_topology');
    } else if (Number(cost.turnCount) > Number(cost.maxTurns || Number.POSITIVE_INFINITY) && !cost.costCap) {
      issues.push('cost_cap_required_for_dense_topology');
    }
  }

  const safe = issues.length === 0;
  const evidenceTypes = safe
    ? ['source_pack', 'baseline_comparison', 'judge_risk_check', 'external_verification']
    : ['judge_risk_check'];

  return {
    safe,
    status: safe ? 'debate_risk_clear' : 'debate_risk_blocked',
    protocol,
    topology,
    judgeModelFamily: judgeFamily,
    participantModelFamilies: participantFamilies,
    persuasionRisk,
    riskFlags,
    issues,
    allowedHighConfidence: safe,
    evidenceTypes,
    promotionDecision: safe ? 'decision_evidence' : 'raw_deliberation',
    entryType: 'debate',
    groundingRefs: GROUNDING_REFS,
  };
}

module.exports = {
  GROUNDING_REFS,
  validateDebateArtifact,
};
