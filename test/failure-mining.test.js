'use strict';

const failureMining = require('../lib/failure-mining');

describe('failure mining anti-pattern registry MVP', () => {
  test('extracts a source-linked anti-pattern from a failed trace', () => {
    const pattern = failureMining.extractAntiPattern({
      command: 'recall intelligence debate-check artifact.json',
      error: 'missing evidence allowed promotion gate bypass',
      symptoms: ['promotion-check passed raw debate output'],
      repairStrategy: 'Require judge-risk check plus external verification evidence.',
      evidenceRefs: ['trace://debate/failure-1'],
    });

    expect(pattern).toMatchObject({
      entryType: 'anti_pattern',
      failureType: 'missing_evidence',
      recurrenceCount: 1,
      status: 'draft',
      promotionDecision: 'candidate_lesson',
    });
    expect(pattern.evidenceRefs).toEqual(['trace://debate/failure-1']);
    expect(pattern.groundingRefs).toContain('reflexion-2023-verbal-rl');
  });

  test('blocks anti-patterns that lack observed outcome evidence', () => {
    const pattern = failureMining.extractAntiPattern({
      failureMode: 'test_regression',
      trigger: 'npm test',
      repairStrategy: 'Add a regression fixture.',
    });

    expect(pattern.status).toBe('blocked_pending_evidence');
    expect(pattern.issues).toEqual(expect.arrayContaining([
      'missing_failure_symptoms',
      'missing_evidence_ref',
    ]));
  });

  test('merges repeated failure shapes and increments recurrence count', () => {
    const first = failureMining.extractAntiPattern({
      command: 'npm test',
      error: 'jest regression in evaluator loop',
      repairStrategy: 'Add a deterministic evaluator fixture.',
      evidenceRefs: ['trace://eval/1'],
    });
    const second = failureMining.extractAntiPattern({
      command: 'npm test',
      error: 'jest regression in evaluator loop',
      repairStrategy: 'Add a deterministic evaluator fixture.',
      evidenceRefs: ['trace://eval/2'],
    });

    const merged = failureMining.mergeAntiPatterns([first, second]);

    expect(merged).toHaveLength(1);
    expect(merged[0].recurrenceCount).toBe(2);
    expect(merged[0].evidenceRefs).toEqual(['trace://eval/1', 'trace://eval/2']);
  });

  test('mines multiple traces into sorted anti-patterns', () => {
    const result = failureMining.mineFailureTraces({
      traces: [
        {
          command: 'npm test',
          error: 'jest regression in evaluator loop',
          repairStrategy: 'Add a deterministic evaluator fixture.',
          evidenceRefs: ['trace://eval/1'],
        },
        {
          command: 'npm test',
          error: 'jest regression in evaluator loop',
          repairStrategy: 'Add a deterministic evaluator fixture.',
          evidenceRefs: ['trace://eval/2'],
        },
        {
          command: 'recall intelligence verifier-check claim.json',
          error: 'proof contains sorry placeholder',
          repairStrategy: 'Reject placeholder proof tokens.',
          evidenceRefs: ['trace://verifier/1'],
        },
      ],
    });

    expect(result).toMatchObject({
      entryType: 'failure_mining_run',
      traceCount: 3,
      antiPatternCount: 2,
    });
    expect(result.antiPatterns[0].recurrenceCount).toBe(2);
  });
});
