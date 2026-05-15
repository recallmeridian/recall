'use strict';

const skillCurriculum = require('../lib/skill-curriculum');

describe('skill library and curriculum engine MVP', () => {
  const skill = {
    id: 'skill-recall-evaluator-loop',
    project: 'recall-dev',
    title: 'Skill: evaluator loop validation',
    status: 'promoted',
    promotionDecision: 'promoted_with_evaluation',
    reliability: 0.8,
    preconditions: ['Use when candidate programs need objective scoring.'],
    procedure: 'Run evaluator candidates against explicit tests and retain scored lineage.',
    sourceTraceIds: ['trace-evaluator'],
    sourceLessonIds: ['lesson-evaluator'],
    evaluationEvidenceRefs: ['benchmark://eval/pass'],
    researchRefs: ['funsearch-2023-program-search'],
  };

  test('builds a searchable skill card with reliability and source links', () => {
    const card = skillCurriculum.buildSkillCard(skill);

    expect(card).toMatchObject({
      entryType: 'skill_card',
      id: 'skill-recall-evaluator-loop',
      capability: 'skill-evaluator-loop-validation',
      status: 'promoted',
      reliability: 0.8,
      sourceTraceIds: ['trace-evaluator'],
      evidenceRefs: ['benchmark://eval/pass'],
    });
    expect(card.researchRefs).toEqual(expect.arrayContaining([
      'voyager-2023-open-ended-agent',
      'amem-2025-agentic-memory',
    ]));
    expect(card.searchableText).toContain('candidate programs');
  });

  test('ranks high-value low-readiness gaps above already-ready gaps', () => {
    const tasks = skillCurriculum.buildCurriculumTasks([
      {
        id: 'gap-live-lean',
        title: 'Live Lean adapter',
        capability: 'formal verifier adapter',
        value: 5,
        readiness: 0.1,
      },
      {
        id: 'gap-evaluator',
        title: 'Evaluator loop validation',
        capability: 'evaluator loop validation',
        value: 3,
      },
    ], [skill]);

    expect(tasks[0]).toMatchObject({
      id: 'gap-live-lean',
      status: 'needs_training',
    });
    expect(tasks[1]).toMatchObject({
      id: 'gap-evaluator',
      status: 'ready_to_apply',
      linkedSkillIds: ['skill-recall-evaluator-loop'],
    });
  });

  test('creates a curriculum plan from gaps and skill cards', () => {
    const plan = skillCurriculum.planCurriculum({
      gaps: [{
        id: 'gap-failure-mining',
        title: 'Failure mining recurrence search',
        capability: 'failure mining anti-pattern registry',
        value: 4,
        blockingFeatures: ['robustness loop'],
      }],
    }, [skill]);

    expect(plan).toMatchObject({
      entryType: 'curriculum_plan',
      gapCount: 1,
      skillCount: 1,
      taskCount: 1,
    });
    expect(plan.tasks[0]).toMatchObject({
      entryType: 'curriculum_task',
      status: 'needs_training',
      blockingFeatures: ['robustness loop'],
    });
  });

  test('uses reliable outcome history to boost matching curriculum tasks', () => {
    const tasks = skillCurriculum.buildCurriculumTasks([
      {
        id: 'gap-preflight',
        title: 'Active session preflight',
        capability: 'preflight decision',
        value: 3,
        readiness: 0.2,
      },
      {
        id: 'gap-live-lean',
        title: 'Live Lean adapter',
        capability: 'formal verifier adapter',
        value: 3,
        readiness: 0.2,
      },
    ], [], {
      reliabilityScores: [{
        entryType: 'recommendation_reliability_score',
        subject: 'preflight decision',
        band: 'reliable',
        status: 'recorded',
        reliabilityScore: 0.9,
      }],
    });

    expect(tasks[0]).toMatchObject({
      id: 'gap-preflight',
      reliabilityBand: 'reliable',
      reliabilityScore: 0.9,
      reliabilitySubject: 'preflight decision',
      status: 'needs_training',
    });
    expect(tasks[0].priority).toBeGreaterThan(tasks[1].priority);
    expect(tasks[1]).toMatchObject({
      reliabilityBand: 'insufficient_evidence',
      reliabilityScore: null,
    });
  });

  test('marks curriculum tasks for review when matching reliability is high risk', () => {
    const tasks = skillCurriculum.buildCurriculumTasks([
      {
        id: 'gap-risky-routing',
        title: 'Risky routing',
        capability: 'agent routing',
        value: 5,
        readiness: 0.9,
      },
    ], [skill], {
      reliabilityScores: [{
        entryType: 'recommendation_reliability_score',
        subject: 'agent routing',
        band: 'high_risk',
        status: 'needs_review',
        reliabilityScore: 0,
      }],
    });

    expect(tasks[0]).toMatchObject({
      id: 'gap-risky-routing',
      status: 'needs_review',
      reliabilityBand: 'high_risk',
      reliabilitySubject: 'agent routing',
    });
    expect(tasks[0].recommendedAction).toContain('Review harmful');
  });
});
