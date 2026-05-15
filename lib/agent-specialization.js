'use strict';

const { buildSkillCard, buildCurriculumTasks } = require('./skill-curriculum');

const AGENT_CONTRACTS = [
  {
    id: 'research-cartographer',
    title: 'Research Cartographer',
    modelLane: 'claude-or-codex',
    mission: 'Map the evidence terrain before Recall treats an idea as actionable.',
    owns: [
      'external and Recall research questions',
      'source packs',
      'claim extraction',
      'research gaps',
      'citation quality',
    ],
    mustNot: [
      'promote claims as durable truth',
      'cite secondary summaries when primary sources are needed',
      'treat model consensus as evidence',
      'use downloads or OneDrive as active source of truth',
    ],
    inputs: [
      'decision question or feature idea',
      'project goal',
      'known constraints',
      'candidate options',
      'available Recall/repo evidence',
    ],
    outputs: [
      'source pack',
      'claim table',
      'evidence-quality notes',
      'open research gaps',
      'recommended next evidence-gathering action',
    ],
    recallPorts: [
      'ResearchGapEmitterPort',
      'OptionBriefPort',
      'PromotionGatePort',
    ],
    evidenceRequired: [
      'recall_memory',
      'repo_evidence',
      'external_research',
      'unknown when evidence is missing',
    ],
    successSignals: [
      'decisive claims link to sources',
      'blocking unknowns become research gaps',
      'weak or secondary evidence is labeled',
    ],
    failureSignals: [
      'uncited claims',
      'source laundering',
      'over-broad research scope',
      'no clear next research action',
    ],
    learningLoop: [
      'compare extracted claims against later implementation outcomes',
      'track which source classes predicted useful decisions',
      'promote only research patterns that pass evidence gates',
    ],
    researchRefs: [
      'llm-mas-se-literature-review-2404-04834',
      'context-engineering-code-assistants-2508-08322',
      'erl-self-improving-agents-2603-24639',
      'memskill-self-evolving-memory-skills-2602-02474',
      'memory-for-autonomous-llm-agents-2603-07670',
    ],
  },
  {
    id: 'implementation-builder',
    title: 'Implementation Builder',
    modelLane: 'codex-or-jcode',
    mission: 'Convert a grounded plan into the smallest working implementation slice.',
    owns: [
      'file-level implementation',
      'local tests',
      'scoped diffs',
      'repo pattern matching',
      'handoff notes',
    ],
    mustNot: [
      'rewrite unrelated worktree changes',
      'skip tests for shared behavior',
      'expand scope without a decision record',
      'treat generated code as validated knowledge',
    ],
    inputs: [
      'accepted option or next action',
      'source pack',
      'repo constraints',
      'acceptance criteria',
      'test command',
    ],
    outputs: [
      'scoped patch',
      'changed file list',
      'test results',
      'implementation assumptions',
      'follow-up risks',
    ],
    recallPorts: [
      'BrainstormingDeliberationPort',
      'EvaluationHarnessPort',
      'AgentWeaknessTrackerPort',
    ],
    evidenceRequired: [
      'repo_evidence',
      'experiment_result',
      'human_context when scope is ambiguous',
    ],
    successSignals: [
      'patch is minimal and testable',
      'tests or explicit verification run',
      'assumptions are captured for outcome follow-up',
    ],
    failureSignals: [
      'touches unrelated files',
      'misses existing local patterns',
      'ships without verification',
      'leaves hidden assumptions unstated',
    ],
    learningLoop: [
      'mine review comments and failing tests into anti-patterns',
      'raise reliability only after repeated scoped successes',
      'turn repeated implementation wins into skill cards',
    ],
    researchRefs: [
      'llm-mas-se-literature-review-2404-04834',
      'context-engineering-code-assistants-2508-08322',
      'mosaic-scientific-coding-2510-08804',
      'mapcoder-lite-2509-17489',
      'jcode-1jehuang-primary-repo',
    ],
  },
  {
    id: 'adversarial-reviewer',
    title: 'Adversarial Reviewer',
    modelLane: 'claude-codex-cross-review',
    mission: 'Find the strongest reason the plan or patch could fail before Recall promotes it.',
    owns: [
      'risk review',
      'negative tests',
      'assumption attacks',
      'promotion-blocking objections',
      'debate-to-decision pressure',
    ],
    mustNot: [
      'argue for sport',
      'block on non-decisive preferences',
      'treat clever objections as truth',
      'rewrite the builder patch during review unless assigned',
    ],
    inputs: [
      'plan or diff',
      'decision record',
      'acceptance criteria',
      'source pack',
      'test results',
    ],
    outputs: [
      'findings ordered by severity',
      'missing tests',
      'failed or untested assumptions',
      'promotion recommendation',
      'repair prompt if needed',
    ],
    recallPorts: [
      'AgentDeliberationPort',
      'DecisionJudgePort',
      'AgentWeaknessTrackerPort',
      'PromotionGatePort',
    ],
    evidenceRequired: [
      'repo_evidence',
      'experiment_result',
      'recall_memory',
      'unknown for unverified objections',
    ],
    successSignals: [
      'findings are decision-relevant',
      'severity maps to concrete risk',
      'promotion is blocked only for evidence-backed reasons',
    ],
    failureSignals: [
      'vague skepticism',
      'style-only objections framed as blockers',
      'same-model consensus treated as verification',
      'no repair path',
    ],
    learningLoop: [
      'track which objections later matched real failures',
      'lower weight for noisy review patterns',
      'promote review heuristics only after outcome evidence',
    ],
    researchRefs: [
      'evolving-orchestration-openreview-l0xzpx',
      'llm-mas-se-literature-review-2404-04834',
      'rise-recursive-introspection-2407-18219',
      'memskill-self-evolving-memory-skills-2602-02474',
      'agentnet-decentralized-coordination-2504-00587',
    ],
  },
];

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null);
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function listAgentContracts() {
  return AGENT_CONTRACTS.map((contract) => ({ ...contract }));
}

function getAgentContract(agentId) {
  const contract = AGENT_CONTRACTS.find((candidate) => candidate.id === agentId);
  if (!contract) throw new Error(`Unknown agent contract: ${agentId}`);
  return { ...contract };
}

function buildAgentPrompt(agentId, task = {}) {
  const contract = getAgentContract(agentId);
  const evidenceRequired = contract.evidenceRequired.join(', ');
  const constraints = asArray(task.constraints).map((item) => `- ${item}`).join('\n') || '- Use the repo rules and current task scope.';
  const acceptance = asArray(task.acceptanceCriteria).map((item) => `- ${item}`).join('\n') || '- Return the required outputs for this role.';

  return [
    `You are the ${contract.title}.`,
    '',
    `Mission: ${contract.mission}`,
    '',
    'Owns:',
    ...contract.owns.map((item) => `- ${item}`),
    '',
    'Must not:',
    ...contract.mustNot.map((item) => `- ${item}`),
    '',
    `Task: ${task.summary || 'No task summary supplied.'}`,
    '',
    'Constraints:',
    constraints,
    '',
    'Acceptance criteria:',
    acceptance,
    '',
    `Evidence required: ${evidenceRequired}.`,
    '',
    'Return:',
    ...contract.outputs.map((item) => `- ${item}`),
  ].join('\n');
}

function buildAgentSkillCards(project = 'recall-dev') {
  return AGENT_CONTRACTS.map((contract) => buildSkillCard({
    id: `skill-${contract.id}`,
    project,
    title: `Skill: ${contract.title}`,
    capability: contract.title,
    status: 'draft',
    reliability: 0,
    preconditions: contract.inputs,
    procedure: [
      contract.mission,
      `Owns: ${contract.owns.join('; ')}.`,
      `Must not: ${contract.mustNot.join('; ')}.`,
      `Outputs: ${contract.outputs.join('; ')}.`,
    ].join('\n'),
    sourceTraceIds: [],
    sourceLessonIds: [],
    evaluationEvidenceRefs: [],
    researchRefs: [
      'trace2skill-2026-transferable-agent-skills',
      'reflexion-2023-verbal-rl',
      'expel-2024-experiential-learners',
      ...contract.researchRefs,
    ],
  }));
}

function buildTriadCurriculum(project = 'recall-dev') {
  const skillCards = buildAgentSkillCards(project);
  const gaps = AGENT_CONTRACTS.map((contract) => ({
    id: `gap-${contract.id}`,
    title: `Operationalize ${contract.title}`,
    capability: contract.title,
    value: contract.id === 'implementation-builder' ? 5 : 4,
    readiness: 0.2,
    blockingFeatures: contract.recallPorts,
  }));

  return {
    project,
    agentCount: AGENT_CONTRACTS.length,
    skillCards,
    curriculumTasks: buildCurriculumTasks(gaps, skillCards).map((task) => ({
      ...task,
      status: 'needs_training',
      recommendedAction: 'Run the role on a bounded real task, capture outcome evidence, then raise reliability only if review and verification support it.',
    })),
  };
}

function validateAgentHandoff(handoff = {}) {
  const issues = [];
  if (!handoff.agentId) issues.push('missing_agent_id');
  else if (!AGENT_CONTRACTS.some((contract) => contract.id === handoff.agentId)) issues.push('unknown_agent_id');
  if (!handoff.taskSummary) issues.push('missing_task_summary');
  if (asArray(handoff.evidenceRefs).length === 0) issues.push('missing_evidence_refs');
  if (asArray(handoff.expectedOutputs).length === 0) issues.push('missing_expected_outputs');
  if (asArray(handoff.acceptanceCriteria).length === 0) issues.push('missing_acceptance_criteria');

  return {
    valid: issues.length === 0,
    issues,
    promotionStatus: issues.length === 0 ? 'ready_for_agent' : 'needs_framing',
  };
}

module.exports = {
  AGENT_CONTRACTS,
  listAgentContracts,
  getAgentContract,
  buildAgentPrompt,
  buildAgentSkillCards,
  buildTriadCurriculum,
  validateAgentHandoff,
};
