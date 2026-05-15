'use strict';

const crypto = require('crypto');

const DEFAULT_GROUNDING_REFS = [
  'lemmabench-2026-live-research-level-math',
  'smit-2024-should-we-be-going-mad',
  'funsearch-2023-program-search',
  'math-exploration-scale-2025',
];
const CONTAMINATION_STATUSES = new Set(['clean', 'suspect', 'contaminated']);

function now() {
  return new Date().toISOString();
}

function slugify(value) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'benchmark';
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function ensureTables(kb) {
  kb.db.exec(`
    CREATE TABLE IF NOT EXISTS recall_benchmark_task (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      expected TEXT NOT NULL,
      cutoff_date TEXT NOT NULL,
      contamination_status TEXT NOT NULL,
      tags TEXT NOT NULL,
      grounding_refs TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recall_benchmark_run (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      task_id TEXT NOT NULL,
      run_label TEXT NOT NULL,
      baseline_label TEXT NOT NULL,
      answer TEXT NOT NULL,
      model_cutoff_date TEXT NOT NULL,
      score REAL NOT NULL,
      baseline_score REAL NOT NULL,
      pass_threshold REAL NOT NULL,
      delta REAL NOT NULL,
      passed INTEGER NOT NULL,
      contamination_status TEXT NOT NULL,
      evidence_ref TEXT NOT NULL,
      evidence_types TEXT NOT NULL,
      verifier_ref TEXT NOT NULL,
      grounding_refs TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recall_benchmark_task_project ON recall_benchmark_task(project);
    CREATE INDEX IF NOT EXISTS idx_recall_benchmark_run_project ON recall_benchmark_run(project);
  `);
}

function assertIsoDate(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    throw new Error(`${label} must use YYYY-MM-DD format.`);
  }
}

function addBenchmarkTask(kb, input = {}) {
  ensureTables(kb);
  const timestamp = now();
  const task = {
    id: input.id || `benchmark-${slugify(input.project || 'recall')}-${slugify(input.title || input.prompt).slice(0, 48)}`,
    project: input.project || 'recall-dev',
    title: input.title || input.id || 'Benchmark task',
    prompt: input.prompt || '',
    expected: input.expected || '',
    cutoffDate: input.cutoffDate || '',
    contaminationStatus: input.contaminationStatus || 'clean',
    tags: input.tags || [],
    createdAt: timestamp,
  };
  if (!task.prompt) throw new Error('Benchmark task requires prompt.');
  if (!task.expected) throw new Error('Benchmark task requires expected answer.');
  if (!task.cutoffDate) throw new Error('Benchmark task requires cutoff date.');
  assertIsoDate(task.cutoffDate, 'Benchmark cutoff date');
  if (!CONTAMINATION_STATUSES.has(task.contaminationStatus)) throw new Error(`Unknown contamination status: ${task.contaminationStatus}`);
  task.groundingRefs = input.groundingRefs || [];
  kb.db.prepare(`
    INSERT INTO recall_benchmark_task (
      id, project, title, prompt, expected, cutoff_date, contamination_status, tags, grounding_refs, created_at
    ) VALUES (
      @id, @project, @title, @prompt, @expected, @cutoffDate, @contaminationStatus, @tags, @groundingRefs, @createdAt
    )
    ON CONFLICT(id) DO UPDATE SET
      project = excluded.project,
      title = excluded.title,
      prompt = excluded.prompt,
      expected = excluded.expected,
      cutoff_date = excluded.cutoff_date,
      contamination_status = excluded.contamination_status,
      tags = excluded.tags,
      grounding_refs = excluded.grounding_refs
  `).run({
    ...task,
    tags: JSON.stringify(task.tags),
    groundingRefs: JSON.stringify(task.groundingRefs),
  });
  return task;
}

function scoreAnswer(answer, expected) {
  const normalizedAnswer = String(answer || '').trim().toLowerCase();
  const normalizedExpected = String(expected || '').trim().toLowerCase();
  if (!normalizedAnswer) return 0;
  if (normalizedAnswer === normalizedExpected) return 1;
  if (normalizedAnswer.includes(normalizedExpected)) return 1;
  if (normalizedExpected.includes(normalizedAnswer)) return 0.75;
  const answerTokens = new Set(normalizedAnswer.split(/\W+/).filter(Boolean));
  const expectedTokens = normalizedExpected.split(/\W+/).filter(Boolean);
  if (expectedTokens.length === 0) return 0;
  const overlap = expectedTokens.filter((token) => answerTokens.has(token)).length;
  return Math.max(0, Math.min(1, overlap / expectedTokens.length));
}

function getTask(kb, taskId) {
  ensureTables(kb);
  const row = kb.db.prepare('SELECT * FROM recall_benchmark_task WHERE id = ?').get(taskId);
  if (!row) throw new Error(`Benchmark task not found: ${taskId}`);
  return {
    id: row.id,
    project: row.project,
    title: row.title,
    prompt: row.prompt,
    expected: row.expected,
    cutoffDate: row.cutoff_date,
    contaminationStatus: row.contamination_status,
    tags: JSON.parse(row.tags || '[]'),
    groundingRefs: JSON.parse(row.grounding_refs || '[]'),
    createdAt: row.created_at,
  };
}

function listBenchmarkTasks(kb, filters = {}) {
  ensureTables(kb);
  const where = [];
  const params = {};
  if (filters.project) {
    where.push('project = @project');
    params.project = filters.project;
  }
  params.limit = Number.isFinite(Number(filters.limit)) ? Math.max(1, Number(filters.limit)) : 100;
  return kb.db.prepare(`
    SELECT * FROM recall_benchmark_task
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC, id ASC
    LIMIT @limit
  `).all(params).map((row) => ({
    id: row.id,
    project: row.project,
    title: row.title,
    prompt: row.prompt,
    expected: row.expected,
    cutoffDate: row.cutoff_date,
    contaminationStatus: row.contamination_status,
    tags: JSON.parse(row.tags || '[]'),
    groundingRefs: JSON.parse(row.grounding_refs || '[]'),
    createdAt: row.created_at,
  }));
}

function recordBenchmarkRun(kb, taskId, input = {}) {
  ensureTables(kb);
  const task = getTask(kb, taskId);
  if (task.contaminationStatus !== 'clean') {
    throw new Error(`Benchmark task is not clean: ${task.contaminationStatus}`);
  }
  if (!input.modelCutoffDate) throw new Error('Benchmark run requires model cutoff date.');
  assertIsoDate(input.modelCutoffDate, 'Model cutoff date');
  if (input.modelCutoffDate >= task.cutoffDate) {
    throw new Error(`Model cutoff ${input.modelCutoffDate} is not before benchmark cutoff ${task.cutoffDate}.`);
  }
  if (input.baselineScore === undefined || input.baselineScore === null || input.baselineScore === '') {
    throw new Error('Benchmark run requires an explicit baseline score.');
  }
  if (input.score !== undefined && !input.verifierRef) {
    throw new Error('Benchmark score override requires verifierRef.');
  }
  const score = input.score === undefined ? scoreAnswer(input.answer, task.expected) : Number(input.score);
  const baselineScore = Number(input.baselineScore);
  if (!Number.isFinite(score)) throw new Error('Benchmark score must be numeric.');
  if (!Number.isFinite(baselineScore)) throw new Error('Benchmark baseline score must be numeric.');
  const passThreshold = input.passThreshold === undefined ? 0.75 : Number(input.passThreshold);
  if (!Number.isFinite(passThreshold)) throw new Error('Benchmark pass threshold must be numeric.');
  const delta = score - baselineScore;
  const timestamp = now();
  const runLabelSlug = slugify(input.runLabel || 'recall-assisted');
  const runId = input.id || `benchmark-run-${slugify(task.id)}-${sha256(`${input.runLabel || 'run'}|${input.answer || ''}|${timestamp}`).slice(0, 10)}`;
  const evidenceRef = `benchmark://${task.id}/${runLabelSlug}/${runId}`;
  const evidenceTypes = ['benchmark_task', 'baseline', 'run_result', 'contamination_check', 'evaluation_evidence'];
  const run = {
    id: runId,
    entryType: 'benchmark_result',
    project: input.project || task.project,
    taskId: task.id,
    runLabel: input.runLabel || 'recall-assisted',
    baselineLabel: input.baselineLabel || 'baseline',
    answer: input.answer || '',
    modelCutoffDate: input.modelCutoffDate,
    score,
    baselineScore,
    passThreshold,
    delta,
    passed: score >= passThreshold,
    contaminationStatus: task.contaminationStatus,
    evidenceRef,
    evidenceTypes,
    verifierRef: input.verifierRef || '',
    groundingRefs: task.groundingRefs,
    evidenceRecord: {
      entryType: 'benchmark_result',
      evidenceTypes,
      evidenceRefs: [{ type: 'run_result', sourceUri: evidenceRef }],
      promotionDecision: 'evaluation_evidence',
    },
    promotionDecision: 'evaluation_evidence',
    createdAt: timestamp,
  };
  kb.db.prepare(`
    INSERT INTO recall_benchmark_run (
      id, project, task_id, run_label, baseline_label, answer, model_cutoff_date, score, baseline_score,
      pass_threshold, delta, passed, contamination_status, evidence_ref, evidence_types, verifier_ref, grounding_refs, created_at
    ) VALUES (
      @id, @project, @taskId, @runLabel, @baselineLabel, @answer, @modelCutoffDate, @score, @baselineScore,
      @passThreshold, @delta, @passed, @contaminationStatus, @evidenceRef, @evidenceTypes, @verifierRef, @groundingRefs, @createdAt
    )
  `).run({
    ...run,
    passed: run.passed ? 1 : 0,
    evidenceTypes: JSON.stringify(run.evidenceTypes),
    groundingRefs: JSON.stringify(run.groundingRefs),
  });
  return run;
}

function recordBenchmarkBatch(kb, input = {}) {
  const defaults = {
    project: input.project,
    modelCutoffDate: input.modelCutoffDate,
    baselineScore: input.baselineScore,
    runLabel: input.runLabel,
    baselineLabel: input.baselineLabel,
    passThreshold: input.passThreshold,
    verifierRef: input.verifierRef,
  };
  const answers = Array.isArray(input.answers) ? input.answers : [];
  const runs = [];
  const failures = [];
  answers.forEach((answer) => {
    try {
      const run = recordBenchmarkRun(kb, answer.taskId, {
        ...defaults,
        ...answer,
      });
      runs.push(run);
    } catch (err) {
      failures.push({
        taskId: answer.taskId || '',
        error: err.message,
      });
    }
  });
  const passedCount = runs.filter((run) => run.passed).length;
  return {
    entryType: 'benchmark_batch_run',
    project: input.project || '',
    status: failures.length === 0 && runs.length > 0 ? 'completed' : 'completed_with_failures',
    answerCount: answers.length,
    runCount: runs.length,
    passedCount,
    failedCount: runs.length - passedCount,
    failureCount: failures.length,
    averageScore: runs.length > 0 ? runs.reduce((sum, run) => sum + run.score, 0) / runs.length : null,
    averageDelta: runs.length > 0 ? runs.reduce((sum, run) => sum + run.delta, 0) / runs.length : null,
    runs,
    failures,
    evidenceTypes: runs.length > 0 ? ['benchmark_batch', 'evaluation_evidence'] : [],
    promotionDecision: failures.length === 0 && runs.length > 0 ? 'evaluation_batch_recorded' : 'blocked_pending_benchmark_repairs',
    groundingRefs: DEFAULT_GROUNDING_REFS,
  };
}

function listBenchmarkRuns(kb, filters = {}) {
  ensureTables(kb);
  const where = [];
  const params = {};
  if (filters.project) {
    where.push('project = @project');
    params.project = filters.project;
  }
  if (filters.taskId) {
    where.push('task_id = @taskId');
    params.taskId = filters.taskId;
  }
  params.limit = Number.isFinite(Number(filters.limit)) ? Math.max(1, Number(filters.limit)) : 100;
  return kb.db.prepare(`
    SELECT * FROM recall_benchmark_run
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC
    LIMIT @limit
  `).all(params).map((row) => ({
    id: row.id,
    entryType: 'benchmark_result',
    project: row.project,
    taskId: row.task_id,
    runLabel: row.run_label,
    baselineLabel: row.baseline_label,
    answer: row.answer,
    modelCutoffDate: row.model_cutoff_date,
    score: row.score,
    baselineScore: row.baseline_score,
    passThreshold: row.pass_threshold,
    delta: row.delta,
    passed: Boolean(row.passed),
    contaminationStatus: row.contamination_status,
    evidenceRef: row.evidence_ref,
    evidenceTypes: JSON.parse(row.evidence_types || '[]'),
    verifierRef: row.verifier_ref || '',
    groundingRefs: JSON.parse(row.grounding_refs || '[]'),
    evidenceRecord: {
      entryType: 'benchmark_result',
      evidenceTypes: JSON.parse(row.evidence_types || '[]'),
      evidenceRefs: [{ type: 'run_result', sourceUri: row.evidence_ref }],
      promotionDecision: 'evaluation_evidence',
    },
    promotionDecision: 'evaluation_evidence',
    createdAt: row.created_at,
  }));
}

module.exports = {
  GROUNDING_REFS: DEFAULT_GROUNDING_REFS,
  ensureTables,
  addBenchmarkTask,
  listBenchmarkTasks,
  recordBenchmarkRun,
  recordBenchmarkBatch,
  listBenchmarkRuns,
  scoreAnswer,
};
