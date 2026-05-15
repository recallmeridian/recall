'use strict';

const evaluatorLoop = require('../lib/evaluator-loop');
const promotionGates = require('../lib/promotion-gates');

describe('FunSearch-style evaluator loop MVP', () => {
  const task = {
    id: 'toy-double',
    tests: [
      { input: 1, expected: 2 },
      { input: 2, expected: 4 },
      { input: 3, expected: 6 },
    ],
  };

  test('scores candidate programs and emits promotion-gate-compatible evidence', () => {
    const result = evaluatorLoop.evaluateCandidate(task, {
      id: 'double-v1',
      program: 'function candidate(input) { return input * 2; }',
      parentIds: ['seed-v0'],
    });
    const gate = promotionGates.evaluatePromotionGate(result);

    expect(result).toMatchObject({
      entryType: 'evaluator_candidate',
      candidateId: 'double-v1',
      evaluatorRun: {
        timeoutMs: 1000,
      },
      score: 1,
      passed: 3,
      total: 3,
      promotionDecision: 'scored_candidate',
    });
    expect(result.evidenceTypes).toEqual(['candidate_program', 'evaluator_run', 'score', 'lineage']);
    expect(result.lineageParentIds).toEqual(['seed-v0']);
    expect(gate).toMatchObject({
      allowed: true,
      entryType: 'evaluator_candidate',
    });
  });

  test('retains top scored candidates with deterministic ordering', () => {
    const result = evaluatorLoop.runEvaluatorLoop({
      task,
      retainTop: 1,
      candidates: [
        { id: 'wrong', program: 'function candidate(input) { return input + 1; }' },
        { id: 'right', program: 'function candidate(input) { return input * 2; }' },
      ],
    });

    expect(result.status).toBe('retained_scored_candidates');
    expect(result.retained).toHaveLength(1);
    expect(result.retained[0]).toMatchObject({
      candidateId: 'right',
      score: 1,
    });
  });

  test('blocks candidate promotion when unsafe program tokens appear', () => {
    const result = evaluatorLoop.evaluateCandidate(task, {
      id: 'unsafe',
      program: 'function candidate(input) { return process.env.SECRET || input; }',
    });
    const gate = promotionGates.evaluatePromotionGate(result);

    expect(result.issues).toContain('candidate_program_uses_blocked_token');
    expect(result.promotionDecision).toBe('blocked_pending_score');
    expect(result.evidenceTypes).not.toContain('score');
    expect(gate.allowed).toBe(false);
    expect(gate.missingEvidence).toEqual(['score', 'lineage']);
  });

  test('fails closed without evaluator tests', () => {
    const result = evaluatorLoop.evaluateCandidate({
      id: 'empty-task',
      tests: [],
    }, {
      id: 'candidate',
      program: 'function candidate(input) { return input; }',
    });

    expect(result.issues).toContain('missing_evaluator_tests');
    expect(result.score).toBe(0);
  });
});
