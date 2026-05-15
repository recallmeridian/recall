'use strict';

const crypto = require('crypto');

const evaluationHarness = require('./evaluation-harness');
const intelligenceArtifacts = require('./intelligence-artifacts');
const agentHandoffs = require('./agent-handoff-ledger');

const DEFAULT_GROUNDING_REFS = [
  'reflexion-2023-verbal-rl',
  'memento-2025-memory-consolidation',
  'lemmabench-2026-live-research-level-math',
  'amem-2025-agentic-memory',
];

function clean(value) {
  return String(value || '').trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null);
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function slugify(value) {
  const slug = clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'benchmark';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function cutoffDate(opts = {}) {
  return opts.cutoffDate || new Date().toISOString().slice(0, 10);
}

function taskFromAntiPattern(artifact, opts = {}) {
  const payload = artifact.payload || artifact;
  const failureType = clean(payload.failureType || artifact.title || 'failure');
  const repair = clean(payload.repairStrategy || payload.recommendedAction || payload.draftLesson);
  if (!repair) return null;
  const sourceId = clean(payload.id || artifact.id || failureType);
  return {
    id: `bench-${slugify(opts.project || artifact.project || payload.project || 'recall')}-failure-${sha256(sourceId).slice(0, 10)}`,
    project: opts.project || artifact.project || payload.project || 'recall-dev',
    title: `Failure repair: ${failureType}`.slice(0, 160),
    prompt: `A session hits failure pattern "${failureType}". What repair strategy should Recall apply before trusting the result?`,
    expected: repair,
    cutoffDate: cutoffDate(opts),
    contaminationStatus: 'clean',
    tags: ['expanded', 'failure', failureType].map(slugify),
    groundingRefs: Array.from(new Set([...asArray(payload.groundingRefs || artifact.groundingRefs), ...DEFAULT_GROUNDING_REFS])),
    sourceArtifactId: artifact.id || sourceId,
    sourceType: 'anti_pattern',
  };
}

function taskFromOutcome(artifact, opts = {}) {
  const payload = artifact.payload || artifact;
  const outcome = clean(payload.outcome);
  const actual = clean(payload.actual);
  const ref = clean(payload.recommendationRef || artifact.id);
  if (!ref || !actual || !['helpful', 'harmful', 'neutral'].includes(outcome)) return null;
  const expected = outcome === 'harmful'
    ? `do not repeat recommendation ${ref}; use outcome evidence: ${actual}`
    : `use recommendation ${ref} only with matching context and outcome evidence: ${actual}`;
  return {
    id: `bench-${slugify(opts.project || artifact.project || payload.project || 'recall')}-outcome-${sha256(ref).slice(0, 10)}`,
    project: opts.project || artifact.project || payload.project || 'recall-dev',
    title: `Outcome lesson: ${outcome}`.slice(0, 160),
    prompt: `Recommendation "${ref}" had observed outcome "${outcome}". How should a future session use that evidence?`,
    expected,
    cutoffDate: cutoffDate(opts),
    contaminationStatus: 'clean',
    tags: ['expanded', 'outcome', outcome],
    groundingRefs: Array.from(new Set([...asArray(payload.groundingRefs || artifact.groundingRefs), ...DEFAULT_GROUNDING_REFS])),
    sourceArtifactId: artifact.id || ref,
    sourceType: 'recommendation_outcome',
  };
}

function taskFromHardCase(artifact, opts = {}) {
  const payload = artifact.payload || artifact;
  const signal = clean(payload.failureSignal || payload.taskSummary || artifact.title);
  const lesson = clean(payload.draftLesson || payload.recommendedAction);
  if (!signal || !lesson) return null;
  const sourceId = clean(payload.id || artifact.id || signal);
  return {
    id: `bench-${slugify(opts.project || artifact.project || payload.project || 'recall')}-hard-case-${sha256(sourceId).slice(0, 10)}`,
    project: opts.project || artifact.project || payload.project || 'recall-dev',
    title: `Agent hard case: ${signal}`.slice(0, 160),
    prompt: `An agent handoff reports hard-case signal "${signal}". What lesson or guardrail should the next session apply?`,
    expected: lesson,
    cutoffDate: cutoffDate(opts),
    contaminationStatus: 'clean',
    tags: ['expanded', 'handoff', 'hard-case', slugify(payload.agentId || '')].filter(Boolean),
    groundingRefs: Array.from(new Set([...asArray(payload.groundingRefs || artifact.groundingRefs), ...DEFAULT_GROUNDING_REFS])),
    sourceArtifactId: artifact.id || sourceId,
    sourceType: 'agent_handoff_hard_case',
  };
}

function taskFromHandoff(handoff, opts = {}) {
  const failed = ['failed', 'blocked', 'uncertain'].includes(handoff.outcome) || handoff.failureSignals.length > 0;
  if (!failed) return null;
  const signal = clean(handoff.failureSignals[0] || handoff.outcome);
  const lesson = clean(handoff.draftLessons[0] || `Check ${signal} before repeating ${handoff.taskType} work.`);
  if (!signal || !lesson) return null;
  return {
    id: `bench-${slugify(opts.project || handoff.project || 'recall')}-handoff-${sha256(handoff.id).slice(0, 10)}`,
    project: opts.project || handoff.project || 'recall-dev',
    title: `Handoff regression: ${handoff.taskSummary}`.slice(0, 160),
    prompt: `A ${handoff.agentId} handoff for "${handoff.taskSummary}" had signal "${signal}". What guardrail should future sessions apply?`,
    expected: lesson,
    cutoffDate: cutoffDate(opts),
    contaminationStatus: 'clean',
    tags: ['expanded', 'handoff', slugify(handoff.agentId), slugify(handoff.outcome)].filter(Boolean),
    groundingRefs: DEFAULT_GROUNDING_REFS,
    sourceArtifactId: handoff.id,
    sourceType: 'agent_handoff',
  };
}

function uniqueTasks(tasks) {
  const seen = new Set();
  return tasks.filter((task) => {
    if (!task || seen.has(task.id)) return false;
    seen.add(task.id);
    return true;
  });
}

function expandBenchmarks(kb, opts = {}) {
  const project = opts.project || 'recall-dev';
  const from = new Set(asArray(opts.from).length ? asArray(opts.from) : ['failures', 'outcomes', 'handoffs']);
  const limit = Number.isFinite(Number(opts.limit)) ? Math.max(1, Number(opts.limit)) : 100;
  const candidates = [];
  const sourceCounts = {
    failures: 0,
    outcomes: 0,
    handoffs: 0,
  };

  if (from.has('failures')) {
    const artifacts = intelligenceArtifacts.listArtifacts(kb, {
      project,
      type: 'anti_pattern',
      limit,
    });
    sourceCounts.failures += artifacts.length;
    candidates.push(...artifacts.map((artifact) => taskFromAntiPattern(artifact, opts)));
  }

  if (from.has('outcomes')) {
    const artifacts = intelligenceArtifacts.listArtifacts(kb, {
      project,
      type: 'recommendation_outcome',
      limit,
    });
    sourceCounts.outcomes += artifacts.length;
    candidates.push(...artifacts.map((artifact) => taskFromOutcome(artifact, opts)));
  }

  if (from.has('handoffs')) {
    const hardCaseArtifacts = intelligenceArtifacts.listArtifacts(kb, {
      project,
      type: 'agent_handoff_hard_case',
      limit,
    });
    sourceCounts.handoffs += hardCaseArtifacts.length;
    candidates.push(...hardCaseArtifacts.map((artifact) => taskFromHardCase(artifact, opts)));

    const handoffs = agentHandoffs.listHandoffs(kb, {
      project,
      limit,
    });
    sourceCounts.handoffs += handoffs.length;
    candidates.push(...handoffs.map((handoff) => taskFromHandoff(handoff, opts)));
  }

  const tasks = uniqueTasks(candidates);
  const storedTasks = opts.dryRun ? [] : tasks.map((task) => evaluationHarness.addBenchmarkTask(kb, task));
  const result = {
    entryType: 'benchmark_expansion_run',
    project,
    status: tasks.length > 0 ? 'expanded' : 'no_sources',
    sourceCounts,
    taskCount: tasks.length,
    storedTaskCount: storedTasks.length,
    tasks,
    storedTasks,
    evidenceTypes: ['benchmark_task_generation', 'failure_mining', 'outcome_evidence', 'agent_handoff'],
    promotionDecision: tasks.length > 0 ? 'benchmark_tasks_generated' : 'blocked_pending_sources',
    groundingRefs: DEFAULT_GROUNDING_REFS,
  };
  const storedArtifact = opts.storeArtifact
    ? intelligenceArtifacts.storeArtifact(kb, result, {
      project,
      type: 'benchmark_expansion_run',
    })
    : null;
  return {
    ...result,
    storedArtifact,
  };
}

module.exports = {
  DEFAULT_GROUNDING_REFS,
  expandBenchmarks,
  taskFromAntiPattern,
  taskFromOutcome,
  taskFromHardCase,
  taskFromHandoff,
};
