'use strict';

const specialization = require('../lib/agent-specialization');

describe('Recall agent specialization triad', () => {
  test('defines the first three recommended agent contracts', () => {
    const contracts = specialization.listAgentContracts();

    expect(contracts.map((contract) => contract.id)).toEqual([
      'research-cartographer',
      'implementation-builder',
      'adversarial-reviewer',
    ]);
    expect(contracts[0]).toMatchObject({
      title: 'Research Cartographer',
      recallPorts: expect.arrayContaining(['ResearchGapEmitterPort']),
      evidenceRequired: expect.arrayContaining(['external_research']),
    });
    expect(contracts[1]).toMatchObject({
      title: 'Implementation Builder',
      recallPorts: expect.arrayContaining(['EvaluationHarnessPort']),
      evidenceRequired: expect.arrayContaining(['experiment_result']),
    });
    expect(contracts[2]).toMatchObject({
      title: 'Adversarial Reviewer',
      recallPorts: expect.arrayContaining(['PromotionGatePort']),
      evidenceRequired: expect.arrayContaining(['unknown for unverified objections']),
    });
  });

  test('builds a task prompt with role boundaries and acceptance criteria', () => {
    const prompt = specialization.buildAgentPrompt('implementation-builder', {
      summary: 'Add a deterministic agent contract registry.',
      constraints: ['Do not touch unrelated dirty files.', 'Run focused Jest tests.'],
      acceptanceCriteria: ['Exports all three contracts.', 'Validates handoff framing.'],
    });

    expect(prompt).toContain('You are the Implementation Builder.');
    expect(prompt).toContain('Mission: Convert a grounded plan');
    expect(prompt).toContain('- Do not touch unrelated dirty files.');
    expect(prompt).toContain('- Exports all three contracts.');
    expect(prompt).toContain('- scoped patch');
    expect(prompt).toContain('Evidence required: repo_evidence, experiment_result');
  });

  test('ports contracts into draft Recall skill cards', () => {
    const cards = specialization.buildAgentSkillCards('recall-dev');

    expect(cards).toHaveLength(3);
    expect(cards[0]).toMatchObject({
      entryType: 'skill_card',
      id: 'skill-research-cartographer',
      project: 'recall-dev',
      status: 'draft',
      reliability: 0,
    });
    expect(cards[0].procedure).toContain('Map the evidence terrain');
    expect(cards[0].researchRefs).toEqual(expect.arrayContaining([
      'trace2skill-2026-transferable-agent-skills',
      'reflexion-2023-verbal-rl',
      'voyager-2023-open-ended-agent',
    ]));
  });

  test('creates curriculum tasks for making the triad smarter over time', () => {
    const plan = specialization.buildTriadCurriculum('recall-dev');

    expect(plan).toMatchObject({
      project: 'recall-dev',
      agentCount: 3,
    });
    expect(plan.skillCards).toHaveLength(3);
    expect(plan.curriculumTasks).toHaveLength(3);
    expect(plan.curriculumTasks[0]).toMatchObject({
      id: 'gap-implementation-builder',
      status: 'needs_training',
      blockingFeatures: expect.arrayContaining(['EvaluationHarnessPort']),
    });
  });

  test('validates handoffs before an agent can run', () => {
    const invalid = specialization.validateAgentHandoff({
      agentId: 'research-cartographer',
    });
    const valid = specialization.validateAgentHandoff({
      agentId: 'research-cartographer',
      taskSummary: 'Find research on agent specialization loops.',
      evidenceRefs: ['human_context:user-request'],
      expectedOutputs: ['source pack'],
      acceptanceCriteria: ['Primary sources identified when available.'],
    });

    expect(invalid).toMatchObject({
      valid: false,
      promotionStatus: 'needs_framing',
      issues: expect.arrayContaining([
        'missing_task_summary',
        'missing_evidence_refs',
        'missing_expected_outputs',
        'missing_acceptance_criteria',
      ]),
    });
    expect(valid).toMatchObject({
      valid: true,
      issues: [],
      promotionStatus: 'ready_for_agent',
    });
  });

  test('rejects unknown agent contracts', () => {
    expect(() => specialization.getAgentContract('planner')).toThrow(/Unknown agent contract/);
    expect(specialization.validateAgentHandoff({
      agentId: 'planner',
      taskSummary: 'Plan something.',
      evidenceRefs: ['human_context:user-request'],
      expectedOutputs: ['plan'],
      acceptanceCriteria: ['Clear next action.'],
    })).toMatchObject({
      valid: false,
      issues: ['unknown_agent_id'],
    });
  });
});
