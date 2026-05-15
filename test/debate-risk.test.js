'use strict';

const debateRisk = require('../lib/debate-risk');
const promotionGates = require('../lib/promotion-gates');

describe('debate judge risk mitigation', () => {
  test('blocks same-model judges without external verification', () => {
    const result = debateRisk.validateDebateArtifact({
      sourcePackRef: 'source-pack://fixture',
      judgeModelFamily: 'claude',
      participantModelFamilies: ['claude', 'codex'],
      baselineComparison: { baseline: 'self_consistency', baselineRunRef: 'benchmark://debate/baseline', delta: 0.1 },
      topology: 'single_judge',
    });

    expect(result).toMatchObject({
      safe: false,
      entryType: 'debate',
      persuasionRisk: 'high',
    });
    expect(result.riskFlags).toContain('same_model_judge');
    expect(result.issues).toEqual(expect.arrayContaining([
      'missing_external_verification',
      'same_model_judge_requires_external_verification',
    ]));
  });

  test('produces promotion-gate-compatible evidence when judge risk controls pass', () => {
    const result = debateRisk.validateDebateArtifact({
      sourcePackRef: 'source-pack://fixture',
      judgeModelFamily: 'human',
      participantModelFamilies: ['claude', 'codex'],
      baselineComparison: { baseline: 'self_consistency', baselineRunRef: 'benchmark://debate/baseline', baselineScore: 0.4, debateScore: 0.6 },
      externalVerification: { type: 'benchmark_result', evidenceRef: 'benchmark://debate/fixture' },
      topology: 'sparse',
      cost: { turnCount: 4 },
    });
    const gate = promotionGates.evaluatePromotionGate(result);

    expect(result).toMatchObject({
      safe: true,
      promotionDecision: 'decision_evidence',
    });
    expect(result.evidenceTypes).toEqual([
      'source_pack',
      'baseline_comparison',
      'judge_risk_check',
      'external_verification',
    ]);
    expect(gate).toMatchObject({
      allowed: true,
      entryType: 'debate',
    });
  });

  test('allows same-model judges only with verifier human or ensemble backing', () => {
    const blocked = debateRisk.validateDebateArtifact({
      sourcePackRef: 'source-pack://fixture',
      judgeProtocol: 'same_model_judge',
      judgeModelFamily: 'claude',
      participantModelFamilies: ['codex'],
      baselineComparison: { baselineRunRef: 'benchmark://debate/baseline', baselineScore: 0.5, debateScore: 0.7 },
      externalVerification: { type: 'benchmark_result', evidenceRef: 'benchmark://debate/same-model' },
      topology: 'single_judge',
    });

    const backed = debateRisk.validateDebateArtifact({
      sourcePackRef: 'source-pack://fixture',
      judgeModelFamily: 'claude',
      participantModelFamilies: ['claude', 'codex'],
      baselineComparison: { baselineRunRef: 'benchmark://debate/baseline', delta: 0.2 },
      externalVerification: { type: 'human_review', reviewerRef: 'human-review://jesse/debate-1' },
      topology: 'single_judge',
    });

    expect(blocked.safe).toBe(false);
    expect(blocked.allowedHighConfidence).toBe(false);
    expect(blocked.issues).toContain('same_model_judge_requires_external_verification');
    expect(backed.safe).toBe(true);
    expect(backed.allowedHighConfidence).toBe(true);
  });

  test('fails closed on vague baseline and external verification records', () => {
    const result = debateRisk.validateDebateArtifact({
      sourcePackRef: 'source-pack://fixture',
      judgeModelFamily: 'human',
      participantModelFamilies: ['claude', 'codex'],
      baselineComparison: { baseline: 'self_consistency' },
      externalVerification: { type: 'human_review' },
      topology: 'sparse',
    });

    expect(result.safe).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      'missing_baseline_comparison',
      'invalid_external_verification',
    ]));
  });

  test('blocks dense debate topologies without a cost cap', () => {
    const result = debateRisk.validateDebateArtifact({
      sourcePackRef: 'source-pack://fixture',
      judgeModelFamily: 'human',
      participantModelFamilies: ['claude', 'codex', 'gpt'],
      baselineComparison: { baselineRunRef: 'benchmark://debate/baseline', delta: 0.1 },
      externalVerification: { type: 'human_review', reviewerRef: 'human-review://jesse/debate-2' },
      topology: 'full_mesh',
      cost: { turnCount: 12, maxTurns: 8 },
    });

    expect(result.safe).toBe(false);
    expect(result.issues).toContain('cost_cap_required_for_dense_topology');
    expect(result.groundingRefs).toContain('sparse-communication-debate-2024');
  });

  test('treats missing participant families and zero-delta baselines as blocked', () => {
    const result = debateRisk.validateDebateArtifact({
      sourcePackRef: 'source-pack://fixture',
      judgeModelFamily: 'claude',
      baselineComparison: { baselineRunRef: 'benchmark://debate/baseline', delta: 0 },
      externalVerification: { type: 'benchmark_result', evidenceRef: 'benchmark://debate/zero' },
      topology: 'single_judge',
    });

    expect(result.safe).toBe(false);
    expect(result.riskFlags).toContain('same_model_judge');
    expect(result.issues).toEqual(expect.arrayContaining([
      'missing_participant_model_families',
      'debate_no_baseline_improvement',
      'same_model_judge_requires_external_verification',
    ]));
  });

  test('blocks dense topologies when cost controls are absent', () => {
    const result = debateRisk.validateDebateArtifact({
      sourcePackRef: 'source-pack://fixture',
      judgeModelFamily: 'human',
      participantModelFamilies: ['claude', 'codex'],
      baselineComparison: { baselineRunRef: 'benchmark://debate/baseline', delta: 0.1 },
      externalVerification: { type: 'human_review', reviewerRef: 'human-review://jesse/debate-3' },
      topology: 'multi_agent',
    });

    expect(result.safe).toBe(false);
    expect(result.issues).toContain('cost_cap_required_for_dense_topology');
  });
});
