'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const meridian = require('../lib/meridian-core');
const ledger = require('../lib/agent-handoff-ledger');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recall-agent-handoff-'));
}

function validHandoff(overrides = {}) {
  return {
    id: 'handoff-builder-fixture',
    project: 'recall-dev',
    agentId: 'implementation-builder',
    taskType: 'implementation',
    taskSummary: 'Add the agent handoff ledger.',
    selectedBecause: 'The task requires scoped code changes and tests.',
    evidenceRefs: ['repo:lib/agent-specialization.js', 'human:agent-ledger-request'],
    expectedOutputs: ['ledger module', 'focused tests'],
    actualOutputs: ['created lib/agent-handoff-ledger.js'],
    acceptanceCriteria: ['validates incomplete handoffs', 'lists recent handoffs'],
    filesTouched: ['lib/agent-handoff-ledger.js'],
    commandsRun: ['npm test -- test/agent-handoff-ledger.test.js --runInBand'],
    testsRun: ['test/agent-handoff-ledger.test.js'],
    outcome: 'succeeded',
    promotionRecommendation: 'candidate_lesson',
    costUnits: 1.5,
    durationSeconds: 120,
    ...overrides,
  };
}

describe('agent handoff ledger', () => {
  let dir;
  let kb;

  beforeEach(() => {
    dir = tempDir();
    kb = meridian.init(path.join(dir, 'kb'));
  });

  afterEach(() => {
    if (kb) kb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('validates required handoff framing before recording', () => {
    const validation = ledger.validateHandoff({
      agentId: 'implementation-builder',
    });

    expect(validation).toMatchObject({
      valid: false,
      status: 'needs_framing',
      issues: expect.arrayContaining([
        'missing_task_summary',
        'missing_selected_because',
        'missing_evidence_refs',
        'missing_expected_outputs',
        'missing_acceptance_criteria',
      ]),
    });
    expect(() => ledger.recordHandoff(kb, {
      agentId: 'unknown-agent',
      taskSummary: 'Do a thing.',
      selectedBecause: 'It seemed right.',
      evidenceRefs: ['human:request'],
      expectedOutputs: ['thing'],
      acceptanceCriteria: ['done'],
    })).toThrow(/unknown_agent_id/);
  });

  test('builds valid starter templates for handoff capture', () => {
    const template = ledger.buildHandoffTemplate('research-cartographer', {
      project: 'sensitive-domain-project',
      taskSummary: 'Map evidence for a live-routing promotion.',
    });
    const validation = ledger.validateHandoff(template);

    expect(template).toMatchObject({
      project: 'sensitive-domain-project',
      agentId: 'research-cartographer',
      taskType: 'research',
      outcome: 'pending',
      promotionRecommendation: 'raw_handoff',
    });
    expect(template.skippedAgents).toEqual(expect.arrayContaining([
      'implementation-builder',
      'adversarial-reviewer',
    ]));
    expect(template.expectedOutputs).toEqual(expect.arrayContaining([
      'source pack',
      'open research gaps',
    ]));
    expect(validation).toMatchObject({
      valid: true,
      status: 'ready_to_record',
    });
  });

  test('records and lists a complete handoff', () => {
    const stored = ledger.recordHandoff(kb, validHandoff(), {
      now: '2026-05-03T10:00:00.000Z',
    });
    const listed = ledger.listHandoffs(kb, {
      project: 'recall-dev',
      agentId: 'implementation-builder',
    });

    expect(stored).toMatchObject({
      id: 'handoff-builder-fixture',
      agentId: 'implementation-builder',
      modelLane: 'codex-or-jcode',
      outcome: 'succeeded',
      filesTouched: ['lib/agent-handoff-ledger.js'],
      testsRun: ['test/agent-handoff-ledger.test.js'],
    });
    expect(listed).toHaveLength(1);
    expect(listed[0].evidenceRefs).toEqual(expect.arrayContaining(['repo:lib/agent-specialization.js']));
  });

  test('hard cases require failure signals and mine into draft lessons', () => {
    expect(() => ledger.recordHandoff(kb, validHandoff({
      id: 'blocked-without-signal',
      outcome: 'blocked',
    }))).toThrow(/hard_case_requires_failure_signals/);

    ledger.recordHandoff(kb, validHandoff({
      id: 'handoff-reviewer-hard-case',
      agentId: 'adversarial-reviewer',
      taskType: 'review',
      taskSummary: 'Review a Sensitive-domain live-routing patch.',
      selectedBecause: 'The patch affects promotion and live external-action behavior.',
      expectedOutputs: ['severity-ordered findings'],
      actualOutputs: [],
      outcome: 'blocked',
      failureSignals: ['missing order-output evidence before live routing'],
      draftLessons: ['Live external-action promotion requires order-output evidence, not only dry-run tests.'],
      reviewFindings: ['P1 missing order-output evidence'],
    }));

    const mined = ledger.mineHardCases(kb, { project: 'recall-dev' });

    expect(mined).toMatchObject({
      status: 'draft_lessons_found',
      handoffCount: 1,
      draftLessonCount: 1,
    });
    expect(mined.hardCases[0]).toMatchObject({
      entryType: 'agent_handoff_hard_case',
      agentId: 'adversarial-reviewer',
      promotionDecision: 'blocked_pending_evaluation',
      draftLesson: 'Live external-action promotion requires order-output evidence, not only dry-run tests.',
    });
    expect(mined.hardCases[0].groundingRefs).toEqual(expect.arrayContaining([
      'memskill-self-evolving-memory-skills-2602-02474',
    ]));
  });

  test('router readiness stays blocked until enough covered outcomes exist', () => {
    ledger.recordHandoff(kb, validHandoff({
      id: 'handoff-one',
      agentId: 'implementation-builder',
    }));
    let readiness = ledger.routerReadiness(kb, {
      project: 'recall-dev',
      minimumHandoffs: 3,
      minimumPerAgent: 1,
    });

    expect(readiness).toMatchObject({
      status: 'collect_more_handoffs',
      enoughVolume: false,
      enoughCoverage: false,
    });

    ledger.recordHandoff(kb, validHandoff({
      id: 'handoff-two',
      agentId: 'research-cartographer',
      taskType: 'research',
      selectedBecause: 'The task has source uncertainty.',
      actualOutputs: ['source pack'],
    }));
    ledger.recordHandoff(kb, validHandoff({
      id: 'handoff-three',
      agentId: 'adversarial-reviewer',
      taskType: 'review',
      selectedBecause: 'The task affects promotion safety.',
      actualOutputs: [],
      outcome: 'uncertain',
      failureSignals: ['review needs repo evidence'],
      reviewFindings: ['Need repo evidence before promotion.'],
    }));

    readiness = ledger.routerReadiness(kb, {
      project: 'recall-dev',
      minimumHandoffs: 3,
      minimumPerAgent: 1,
    });

    expect(readiness).toMatchObject({
      status: 'ready_for_suggested_routing',
      handoffCount: 3,
      coveredAgentCount: 3,
      enoughVolume: true,
      enoughCoverage: true,
      hasHardCaseLearning: true,
    });
    expect(readiness.agentStats).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'implementation-builder', successRate: 1 }),
      expect.objectContaining({ agentId: 'adversarial-reviewer', hardCaseRate: 1 }),
    ]));
  });
});
