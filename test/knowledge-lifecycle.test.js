'use strict';

const {
  KNOWLEDGE_STATES,
  validateLifecycleTransition,
} = require('../lib/knowledge-lifecycle');

describe('knowledge lifecycle state contract', () => {
  test('allows raw observations to become candidate beliefs', () => {
    const result = validateLifecycleTransition({
      artifactId: 'entry-1',
      from: KNOWLEDGE_STATES.RAW_OBSERVATION,
      to: KNOWLEDGE_STATES.CANDIDATE_BELIEF,
      reasons: ['classified_as_candidate'],
    }, {
      actor: 'feature-runner',
      now: '2026-05-03T00:00:00.000Z',
    });

    expect(result.ok).toBe(true);
    expect(result.signal).toMatchObject({
      artifactId: 'entry-1',
      actor: 'feature-runner',
      decidedAt: '2026-05-03T00:00:00.000Z',
    });
  });

  test('requires evidence before validating knowledge', () => {
    const result = validateLifecycleTransition({
      artifactId: 'entry-2',
      from: KNOWLEDGE_STATES.CANDIDATE_BELIEF,
      to: KNOWLEDGE_STATES.VALIDATED_KNOWLEDGE,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('validation_requires_evidence');
  });

  test('requires falsifier shape for contradicted and superseded states', () => {
    const contradicted = validateLifecycleTransition({
      artifactId: 'entry-3',
      from: KNOWLEDGE_STATES.VALIDATED_KNOWLEDGE,
      to: KNOWLEDGE_STATES.CONTRADICTED,
    });
    const superseded = validateLifecycleTransition({
      artifactId: 'entry-4',
      from: KNOWLEDGE_STATES.VALIDATED_KNOWLEDGE,
      to: KNOWLEDGE_STATES.SUPERSEDED,
      falsifier: ['newer measurement displaced this rule'],
    });

    expect(contradicted.ok).toBe(false);
    expect(contradicted.errors).toContain('falsifier_required');
    expect(superseded.ok).toBe(true);
  });

  test('rejects impossible lifecycle jumps', () => {
    const result = validateLifecycleTransition({
      artifactId: 'entry-5',
      from: KNOWLEDGE_STATES.RETIRED,
      to: KNOWLEDGE_STATES.VALIDATED_KNOWLEDGE,
      evidenceRefs: ['recall://research/source'],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('transition_not_allowed');
  });
});
