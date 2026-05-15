'use strict';

const promotionGates = require('../lib/promotion-gates');

describe('typed promotion gates', () => {
  test('blocks skill promotion without evaluation evidence', () => {
    const result = promotionGates.evaluatePromotionGate({
      entryType: 'skill',
      evidenceTypes: ['source_trace'],
    });

    expect(result).toMatchObject({
      allowed: false,
      entryType: 'skill',
      allowedPromotion: 'validated_skill',
      missingEvidence: ['evaluation_evidence'],
    });
    expect(result.groundingRefs).toContain('trace2skill-2026-transferable-agent-skills');
  });

  test('allows skill promotion with source trace and evaluation evidence', () => {
    const result = promotionGates.evaluatePromotionGate({
      entryType: 'skill',
      evidenceTypes: ['source_trace', 'evaluation_evidence'],
    }, {
      requestedPromotion: 'validated_skill',
    });

    expect(result).toMatchObject({
      allowed: true,
      missingEvidence: [],
    });
  });

  test('requires formal verifier evidence for verifier results', () => {
    const result = promotionGates.evaluatePromotionGate({
      entryType: 'verifier_result',
      evidenceTypes: ['formal_statement', 'verifier_run'],
    });

    expect(result).toMatchObject({
      allowed: false,
      missingEvidence: ['proof_artifact'],
    });
    expect(result.groundingRefs).toContain('alphaproof-2025-formal-math-rl');
  });

  test('blocks debate promotion without judge risk controls and external verification', () => {
    const result = promotionGates.evaluatePromotionGate({
      entryType: 'debate',
      evidenceTypes: ['source_pack', 'baseline_comparison'],
    });

    expect(result).toMatchObject({
      allowed: false,
      missingEvidence: ['judge_risk_check', 'external_verification'],
    });
    expect(result.groundingRefs).toContain('agarwal-2025-persuasion-overrides-truth');
  });

  test('rejects mismatched promotion decisions even when evidence is present', () => {
    const result = promotionGates.evaluatePromotionGate({
      entryType: 'benchmark_result',
      evidenceTypes: ['benchmark_task', 'baseline', 'run_result', 'contamination_check'],
    }, {
      requestedPromotion: 'validated_skill',
    });

    expect(result.allowed).toBe(false);
    expect(result.reasons.join(' ')).toContain('does not match');
  });

  test('rejects untyped artifacts instead of defaulting to lesson', () => {
    const result = promotionGates.evaluatePromotionGate({
      evidenceTypes: ['source_trace', 'outcome_evidence'],
    });

    expect(result).toMatchObject({
      allowed: false,
      entryType: '',
      missingEvidence: ['explicit_entry_type'],
    });
  });

  test('normalizes raw deliberation and skill candidate aliases to stricter gates', () => {
    const debate = promotionGates.evaluatePromotionGate({
      _extensions: {
        promotionGateType: 'raw_deliberation',
        evidenceTypes: ['source_trace', 'outcome_evidence'],
      },
    });
    const skill = promotionGates.evaluatePromotionGate({
      entryType: 'skill_candidate',
      promotionDecision: 'blocked_pending_evaluation',
      evidenceRefs: [
        { type: 'source_trace' },
        { type: 'evaluation_evidence' },
      ],
    });

    expect(debate.entryType).toBe('debate');
    expect(debate.missingEvidence).toEqual([
      'source_pack',
      'baseline_comparison',
      'judge_risk_check',
      'external_verification',
    ]);
    expect(skill).toMatchObject({
      allowed: true,
      entryType: 'skill',
      requestedPromotion: 'validated_skill',
    });
  });
});
