'use strict';

const crypto = require('crypto');
const { listAgentContracts, getAgentContract } = require('./agent-specialization');

const OUTCOMES = new Set([
  'pending',
  'succeeded',
  'failed',
  'blocked',
  'uncertain',
  'needs_review',
]);

const LEARNING_REFS = [
  'evolving-orchestration-openreview-l0xzpx',
  'erl-self-improving-agents-2603-24639',
  'memskill-self-evolving-memory-skills-2602-02474',
  'memory-for-autonomous-llm-agents-2603-07670',
  'rise-recursive-introspection-2407-18219',
];

function now() {
  return new Date().toISOString();
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null);
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function clean(value) {
  return String(value || '').trim();
}

function slugify(value) {
  const slug = clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'handoff';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function agentIds() {
  return new Set(listAgentContracts().map((contract) => contract.id));
}

function ensureTables(kb) {
  kb.db.exec(`
    CREATE TABLE IF NOT EXISTS recall_agent_handoff (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      model_lane TEXT NOT NULL,
      task_type TEXT NOT NULL,
      task_summary TEXT NOT NULL,
      selected_because TEXT NOT NULL,
      skipped_agents TEXT NOT NULL,
      evidence_refs TEXT NOT NULL,
      expected_outputs TEXT NOT NULL,
      actual_outputs TEXT NOT NULL,
      files_touched TEXT NOT NULL,
      commands_run TEXT NOT NULL,
      tests_run TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL,
      review_findings TEXT NOT NULL,
      failure_signals TEXT NOT NULL,
      draft_lessons TEXT NOT NULL,
      outcome TEXT NOT NULL,
      promotion_recommendation TEXT NOT NULL,
      cost_units REAL NOT NULL,
      duration_seconds REAL NOT NULL,
      payload_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recall_agent_handoff_project ON recall_agent_handoff(project);
    CREATE INDEX IF NOT EXISTS idx_recall_agent_handoff_agent ON recall_agent_handoff(agent_id);
    CREATE INDEX IF NOT EXISTS idx_recall_agent_handoff_outcome ON recall_agent_handoff(outcome);
    CREATE INDEX IF NOT EXISTS idx_recall_agent_handoff_task_type ON recall_agent_handoff(task_type);
  `);
}

function normalizeHandoff(input = {}, context = {}) {
  const agentId = clean(input.agentId || input.agent || input.role);
  const contract = agentId && agentIds().has(agentId) ? getAgentContract(agentId) : null;
  const timestamp = input.createdAt || context.now || now();
  const taskSummary = clean(input.taskSummary || input.summary || input.task);
  const payload = {
    id: clean(input.id) || `handoff-${slugify(agentId)}-${sha256(`${taskSummary}|${timestamp}`).slice(0, 12)}`,
    project: clean(input.project || context.project || 'recall-dev'),
    agentId,
    modelLane: clean(input.modelLane || input.model || (contract && contract.modelLane) || 'unknown'),
    taskType: clean(input.taskType || 'general'),
    taskSummary,
    selectedBecause: clean(input.selectedBecause || input.whySelected || ''),
    skippedAgents: asArray(input.skippedAgents),
    evidenceRefs: asArray(input.evidenceRefs || input.inputEvidenceRefs),
    expectedOutputs: asArray(input.expectedOutputs),
    actualOutputs: asArray(input.actualOutputs),
    filesTouched: asArray(input.filesTouched || input.changedFiles),
    commandsRun: asArray(input.commandsRun),
    testsRun: asArray(input.testsRun),
    acceptanceCriteria: asArray(input.acceptanceCriteria),
    reviewFindings: asArray(input.reviewFindings),
    failureSignals: asArray(input.failureSignals),
    draftLessons: asArray(input.draftLessons),
    outcome: clean(input.outcome || 'pending'),
    promotionRecommendation: clean(input.promotionRecommendation || ''),
    costUnits: Number.isFinite(Number(input.costUnits)) ? Number(input.costUnits) : 0,
    durationSeconds: Number.isFinite(Number(input.durationSeconds)) ? Number(input.durationSeconds) : 0,
    createdAt: timestamp,
    updatedAt: input.updatedAt || timestamp,
  };
  return payload;
}

function validateHandoff(input = {}) {
  const handoff = normalizeHandoff(input);
  const ids = agentIds();
  const issues = [];

  if (!handoff.agentId) issues.push('missing_agent_id');
  else if (!ids.has(handoff.agentId)) issues.push('unknown_agent_id');
  if (!handoff.taskSummary) issues.push('missing_task_summary');
  if (!handoff.selectedBecause) issues.push('missing_selected_because');
  if (handoff.evidenceRefs.length === 0) issues.push('missing_evidence_refs');
  if (handoff.expectedOutputs.length === 0) issues.push('missing_expected_outputs');
  if (handoff.acceptanceCriteria.length === 0) issues.push('missing_acceptance_criteria');
  if (!OUTCOMES.has(handoff.outcome)) issues.push('invalid_outcome');
  if (handoff.outcome === 'succeeded' && handoff.actualOutputs.length === 0) issues.push('succeeded_requires_actual_outputs');
  if (['failed', 'blocked', 'uncertain'].includes(handoff.outcome) && handoff.failureSignals.length === 0) {
    issues.push('hard_case_requires_failure_signals');
  }

  return {
    valid: issues.length === 0,
    issues,
    handoff,
    status: issues.length === 0 ? 'ready_to_record' : 'needs_framing',
  };
}

// Paths that, when touched, mark a handoff as architecturally significant.
// Touching these means the session moved something user-visible or load-bearing
// (CLI surface, engine, distribution, doctrine docs, migrations).
const SIGNIFICANT_PATH_PATTERNS = [
  /(^|\/)package\.json$/,
  /(^|\/)LICENSE(\.\w+)?$/i,
  /(^|\/)SECURITY\.md$/i,
  /(^|\/)CONTRIBUTING\.md$/i,
  /(^|\/)AGENTS\.md$/i,
  /(^|\/)CLAUDE\.md$/i,
  /(^|\/)bin\/[^/]+$/,
  /(^|\/)lib\/meridian-core\//,
  /(^|\/)lib\/commands\/[^/]+$/,
  /(^|\/)scripts\/(export-public-mirror|release-|publish-|mirror-)/,
  /(^|\/)migrations?\//,
];

const SIGNIFICANT_TASK_TYPES = new Set([
  'process-rule',
  'planning',
]);

const SIGNIFICANT_KEYWORDS = [
  'decision',
  'doctrine',
  'milestone',
  'release',
  'launch',
  'cutover',
  'promotion',
  'open source',
  'open-source',
];

const PROMOTABLE_RECOMMENDATIONS = new Set([
  'candidate_lesson',
  'candidate_decision',
  'candidate_milestone',
]);

function isSignificantHandoff(handoff) {
  if (handoff.significant === true) return true;
  if (SIGNIFICANT_TASK_TYPES.has(handoff.taskType)) return true;

  const haystack = `${handoff.taskSummary || ''} ${handoff.selectedBecause || ''}`.toLowerCase();
  if (SIGNIFICANT_KEYWORDS.some((kw) => haystack.includes(kw))) return true;

  const files = Array.isArray(handoff.filesTouched) ? handoff.filesTouched : [];
  if (files.some((file) => SIGNIFICANT_PATH_PATTERNS.some((rx) => rx.test(String(file))))) {
    return true;
  }

  return false;
}

// Promotion-readiness validator. Extends validateHandoff with the gate that
// closes the IL→KB promotion edge: significant succeeded handoffs MUST carry
// draft lessons, review findings, and a non-raw promotion recommendation so
// the nightly/event-driven cycle has something to promote.
//
// Ports Truth/Evidence/Promotion doctrine (decision-1777317024151) to the
// handoff layer. Without this, the doctrine is enforced for code cutovers
// but bypassed for knowledge promotion — the failure mode that produced 119
// commits + 43 handoffs + 0 decision entries in the 2026-04-26→2026-05-12
// open-source release sprint.
function validatePromotionReadiness(input = {}) {
  const base = validateHandoff(input);
  const { handoff } = base;
  const significant = isSignificantHandoff(handoff);
  const issues = [...base.issues];

  if (significant && handoff.outcome === 'succeeded') {
    if (handoff.draftLessons.length === 0) {
      issues.push('significant_handoff_missing_draft_lessons');
    }
    if (handoff.reviewFindings.length === 0) {
      issues.push('significant_handoff_missing_review_findings');
    }
    const rec = handoff.promotionRecommendation || 'raw_handoff';
    if (!PROMOTABLE_RECOMMENDATIONS.has(rec)) {
      issues.push('significant_handoff_promotion_recommendation_must_be_candidate');
    }
  }

  let status;
  if (issues.length === 0) {
    status = significant ? 'ready_to_promote' : 'ready_to_record';
  } else if (significant && base.valid) {
    status = 'needs_promotion_framing';
  } else {
    status = base.status;
  }

  return {
    valid: issues.length === 0,
    issues,
    significant,
    handoff,
    status,
  };
}

function buildHandoffTemplate(agentId, opts = {}) {
  const contract = getAgentContract(agentId);
  return normalizeHandoff({
    project: opts.project || 'recall-dev',
    agentId,
    modelLane: opts.modelLane || contract.modelLane,
    taskType: opts.taskType || (agentId === 'research-cartographer'
      ? 'research'
      : agentId === 'adversarial-reviewer'
        ? 'review'
        : 'implementation'),
    taskSummary: opts.taskSummary || `Describe the ${contract.title} task here.`,
    selectedBecause: opts.selectedBecause || contract.mission,
    skippedAgents: listAgentContracts()
      .map((candidate) => candidate.id)
      .filter((candidate) => candidate !== agentId),
    evidenceRefs: opts.evidenceRefs || ['human:<request-or-constraint>', 'repo:<file-or-doc>'],
    expectedOutputs: opts.expectedOutputs || contract.outputs,
    actualOutputs: [],
    filesTouched: [],
    commandsRun: [],
    testsRun: [],
    acceptanceCriteria: opts.acceptanceCriteria || contract.successSignals,
    reviewFindings: [],
    failureSignals: [],
    draftLessons: [],
    outcome: 'pending',
    promotionRecommendation: 'raw_handoff',
    costUnits: 0,
    durationSeconds: 0,
  }, opts);
}

function rowFromHandoff(handoff) {
  const payloadJson = JSON.stringify(handoff);
  return {
    id: handoff.id,
    project: handoff.project,
    agentId: handoff.agentId,
    modelLane: handoff.modelLane,
    taskType: handoff.taskType,
    taskSummary: handoff.taskSummary,
    selectedBecause: handoff.selectedBecause,
    skippedAgents: JSON.stringify(handoff.skippedAgents),
    evidenceRefs: JSON.stringify(handoff.evidenceRefs),
    expectedOutputs: JSON.stringify(handoff.expectedOutputs),
    actualOutputs: JSON.stringify(handoff.actualOutputs),
    filesTouched: JSON.stringify(handoff.filesTouched),
    commandsRun: JSON.stringify(handoff.commandsRun),
    testsRun: JSON.stringify(handoff.testsRun),
    acceptanceCriteria: JSON.stringify(handoff.acceptanceCriteria),
    reviewFindings: JSON.stringify(handoff.reviewFindings),
    failureSignals: JSON.stringify(handoff.failureSignals),
    draftLessons: JSON.stringify(handoff.draftLessons),
    outcome: handoff.outcome,
    promotionRecommendation: handoff.promotionRecommendation,
    costUnits: handoff.costUnits,
    durationSeconds: handoff.durationSeconds,
    payloadJson,
    contentHash: sha256(payloadJson),
    createdAt: handoff.createdAt,
    updatedAt: handoff.updatedAt || now(),
  };
}

function handoffFromRow(row) {
  return {
    id: row.id,
    project: row.project,
    agentId: row.agent_id,
    modelLane: row.model_lane,
    taskType: row.task_type,
    taskSummary: row.task_summary,
    selectedBecause: row.selected_because,
    skippedAgents: JSON.parse(row.skipped_agents || '[]'),
    evidenceRefs: JSON.parse(row.evidence_refs || '[]'),
    expectedOutputs: JSON.parse(row.expected_outputs || '[]'),
    actualOutputs: JSON.parse(row.actual_outputs || '[]'),
    filesTouched: JSON.parse(row.files_touched || '[]'),
    commandsRun: JSON.parse(row.commands_run || '[]'),
    testsRun: JSON.parse(row.tests_run || '[]'),
    acceptanceCriteria: JSON.parse(row.acceptance_criteria || '[]'),
    reviewFindings: JSON.parse(row.review_findings || '[]'),
    failureSignals: JSON.parse(row.failure_signals || '[]'),
    draftLessons: JSON.parse(row.draft_lessons || '[]'),
    outcome: row.outcome,
    promotionRecommendation: row.promotion_recommendation,
    costUnits: row.cost_units,
    durationSeconds: row.duration_seconds,
    contentHash: row.content_hash,
    payload: JSON.parse(row.payload_json || '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function recordHandoff(kb, input = {}, context = {}) {
  ensureTables(kb);
  const validation = validateHandoff(normalizeHandoff(input, context));
  if (!validation.valid) {
    const err = new Error(`Agent handoff is incomplete: ${validation.issues.join(', ')}`);
    err.issues = validation.issues;
    throw err;
  }
  const handoff = {
    ...validation.handoff,
    updatedAt: context.now || now(),
  };
  const row = rowFromHandoff(handoff);
  const existing = kb.db.prepare('SELECT created_at FROM recall_agent_handoff WHERE id = ?').get(row.id);
  kb.db.prepare(`
    INSERT INTO recall_agent_handoff (
      id, project, agent_id, model_lane, task_type, task_summary, selected_because,
      skipped_agents, evidence_refs, expected_outputs, actual_outputs, files_touched,
      commands_run, tests_run, acceptance_criteria, review_findings, failure_signals,
      draft_lessons, outcome, promotion_recommendation, cost_units, duration_seconds,
      payload_json, content_hash, created_at, updated_at
    ) VALUES (
      @id, @project, @agentId, @modelLane, @taskType, @taskSummary, @selectedBecause,
      @skippedAgents, @evidenceRefs, @expectedOutputs, @actualOutputs, @filesTouched,
      @commandsRun, @testsRun, @acceptanceCriteria, @reviewFindings, @failureSignals,
      @draftLessons, @outcome, @promotionRecommendation, @costUnits, @durationSeconds,
      @payloadJson, @contentHash, @createdAt, @updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      project = excluded.project,
      agent_id = excluded.agent_id,
      model_lane = excluded.model_lane,
      task_type = excluded.task_type,
      task_summary = excluded.task_summary,
      selected_because = excluded.selected_because,
      skipped_agents = excluded.skipped_agents,
      evidence_refs = excluded.evidence_refs,
      expected_outputs = excluded.expected_outputs,
      actual_outputs = excluded.actual_outputs,
      files_touched = excluded.files_touched,
      commands_run = excluded.commands_run,
      tests_run = excluded.tests_run,
      acceptance_criteria = excluded.acceptance_criteria,
      review_findings = excluded.review_findings,
      failure_signals = excluded.failure_signals,
      draft_lessons = excluded.draft_lessons,
      outcome = excluded.outcome,
      promotion_recommendation = excluded.promotion_recommendation,
      cost_units = excluded.cost_units,
      duration_seconds = excluded.duration_seconds,
      payload_json = excluded.payload_json,
      content_hash = excluded.content_hash,
      updated_at = excluded.updated_at
  `).run({
    ...row,
    createdAt: existing ? existing.created_at : row.createdAt,
  });
  return handoffFromRow(kb.db.prepare('SELECT * FROM recall_agent_handoff WHERE id = ?').get(row.id));
}

function listHandoffs(kb, filters = {}) {
  ensureTables(kb);
  const where = [];
  const params = {};
  if (filters.project) {
    where.push('project = @project');
    params.project = filters.project;
  }
  if (filters.agentId || filters.agent) {
    where.push('agent_id = @agentId');
    params.agentId = filters.agentId || filters.agent;
  }
  if (filters.outcome) {
    where.push('outcome = @outcome');
    params.outcome = filters.outcome;
  }
  if (filters.taskType) {
    where.push('task_type = @taskType');
    params.taskType = filters.taskType;
  }
  if (filters.query) {
    where.push('(task_summary LIKE @query OR selected_because LIKE @query)');
    params.query = `%${filters.query}%`;
  }
  params.limit = Number.isFinite(Number(filters.limit)) ? Math.max(1, Number(filters.limit)) : 100;
  return kb.db.prepare(`
    SELECT * FROM recall_agent_handoff
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY updated_at DESC, id ASC
    LIMIT @limit
  `).all(params).map(handoffFromRow);
}

// Some handoff producers (notably implementation-builder for sandbox failures)
// emit structured failure signals like { signal: 'sandbox_eperm', detail: '...' }
// rather than plain strings. Plain `String(obj)` turns those into "[object Object]"
// which then clusters into a meaningless "[object object]" basin in the Trace
// Optimizer. This helper canonicalizes any signal shape into a stable text form
// so downstream clustering, prompts, and templates all see a readable string.
function toFailureSignalString(signal) {
  if (signal === null || signal === undefined) return '';
  if (typeof signal === 'string') return signal.trim();
  if (typeof signal !== 'object') return String(signal);
  const head = signal.signal || signal.summary || signal.message || signal.code || signal.title || signal.type;
  const tail = signal.detail || signal.description || signal.reason;
  if (head && tail) return `${String(head).trim()}: ${String(tail).trim()}`;
  if (head) return String(head).trim();
  if (tail) return String(tail).trim();
  try { return JSON.stringify(signal); } catch (_) { return '[unstringifiable signal]'; }
}

function mineHardCases(kb, filters = {}) {
  const hardOutcomes = new Set(['failed', 'blocked', 'uncertain']);
  const handoffs = listHandoffs(kb, {
    ...filters,
    outcome: undefined,
    limit: filters.limit || 200,
  }).filter((handoff) => hardOutcomes.has(handoff.outcome) || handoff.failureSignals.length > 0);
  const drafts = handoffs.flatMap((handoff) => {
    const signals = handoff.failureSignals.length ? handoff.failureSignals : [`outcome=${handoff.outcome}`];
    return signals.map((signal, index) => {
      const signalText = toFailureSignalString(signal);
      const rawDraftLesson = handoff.draftLessons[index];
      const draftLesson = typeof rawDraftLesson === 'string' && rawDraftLesson
        ? rawDraftLesson
        : (rawDraftLesson && typeof rawDraftLesson === 'object'
          ? (rawDraftLesson.lesson || rawDraftLesson.summary || JSON.stringify(rawDraftLesson))
          : `When ${handoff.agentId} handles ${handoff.taskType}, guard against: ${signalText}.`);
      return {
        entryType: 'agent_handoff_hard_case',
        id: `hard-case-${handoff.id}-${index + 1}`,
        project: handoff.project,
        handoffId: handoff.id,
        agentId: handoff.agentId,
        taskType: handoff.taskType,
        failureSignal: signalText,
        failureSignalRaw: signal,
        draftLesson,
        recommendedAction: 'Promote only after this lesson is validated by a later successful handoff or targeted evaluation.',
        promotionDecision: 'blocked_pending_evaluation',
        evidenceRefs: handoff.evidenceRefs,
        groundingRefs: LEARNING_REFS,
        status: 'draft',
      };
    });
  });
  return {
    entryType: 'agent_handoff_hard_case_mining',
    status: drafts.length ? 'draft_lessons_found' : 'no_hard_cases',
    handoffCount: handoffs.length,
    draftLessonCount: drafts.length,
    hardCases: drafts,
    groundingRefs: LEARNING_REFS,
  };
}

function routerReadiness(kb, filters = {}) {
  const handoffs = listHandoffs(kb, {
    ...filters,
    limit: filters.limit || 500,
  });
  const byAgent = new Map();
  for (const handoff of handoffs) {
    if (!byAgent.has(handoff.agentId)) {
      byAgent.set(handoff.agentId, {
        agentId: handoff.agentId,
        count: 0,
        succeeded: 0,
        hardCases: 0,
        reviewed: 0,
      });
    }
    const stats = byAgent.get(handoff.agentId);
    stats.count += 1;
    if (handoff.outcome === 'succeeded') stats.succeeded += 1;
    if (['failed', 'blocked', 'uncertain'].includes(handoff.outcome)) stats.hardCases += 1;
    if (handoff.reviewFindings.length > 0) stats.reviewed += 1;
  }
  const agentStats = Array.from(byAgent.values()).map((stats) => ({
    ...stats,
    successRate: stats.count ? Number((stats.succeeded / stats.count).toFixed(4)) : 0,
    hardCaseRate: stats.count ? Number((stats.hardCases / stats.count).toFixed(4)) : 0,
  })).sort((left, right) => left.agentId.localeCompare(right.agentId));
  const coveredAgentCount = agentStats.filter((stats) => stats.count > 0).length;
  const minimumHandoffs = Number.isFinite(Number(filters.minimumHandoffs)) ? Number(filters.minimumHandoffs) : 9;
  const minimumPerAgent = Number.isFinite(Number(filters.minimumPerAgent)) ? Number(filters.minimumPerAgent) : 2;
  const enoughVolume = handoffs.length >= minimumHandoffs;
  const enoughCoverage = coveredAgentCount >= 3 && agentStats.every((stats) => stats.count >= minimumPerAgent);
  const hasHardCaseLearning = agentStats.some((stats) => stats.hardCases > 0);
  const status = enoughVolume && enoughCoverage && hasHardCaseLearning
    ? 'ready_for_suggested_routing'
    : 'collect_more_handoffs';
  return {
    entryType: 'agent_router_readiness',
    status,
    project: filters.project || '',
    handoffCount: handoffs.length,
    coveredAgentCount,
    minimumHandoffs,
    minimumPerAgent,
    enoughVolume,
    enoughCoverage,
    hasHardCaseLearning,
    agentStats,
    nextAction: status === 'ready_for_suggested_routing'
      ? 'Add deterministic router suggestions while keeping human approval for execution.'
      : 'Record more handoffs with outcomes, reviews, and hard-case lessons before routing automatically.',
    groundingRefs: [
      'evolving-orchestration-openreview-l0xzpx',
      'agentnet-decentralized-coordination-2504-00587',
      'memskill-self-evolving-memory-skills-2602-02474',
    ],
  };
}

module.exports = {
  OUTCOMES,
  LEARNING_REFS,
  SIGNIFICANT_PATH_PATTERNS,
  SIGNIFICANT_TASK_TYPES,
  SIGNIFICANT_KEYWORDS,
  PROMOTABLE_RECOMMENDATIONS,
  ensureTables,
  normalizeHandoff,
  buildHandoffTemplate,
  validateHandoff,
  isSignificantHandoff,
  validatePromotionReadiness,
  recordHandoff,
  listHandoffs,
  mineHardCases,
  routerReadiness,
  toFailureSignalString,
};
