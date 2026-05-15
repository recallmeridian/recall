'use strict';

const crypto = require('crypto');
const vm = require('vm');

const GROUNDING_REFS = [
  'funsearch-2023-program-search',
  'alphaevolve-2025-coding-agent-discovery',
  'math-exploration-scale-2025',
];

const BLOCKED_TOKENS = /\b(require|process|global|globalThis|Function|eval|import|module|exports|constructor)\b/;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableId(prefix, value) {
  return `${prefix}-${sha256(JSON.stringify(value)).slice(0, 12)}`;
}

function compileCandidate(program, timeoutMs) {
  if (BLOCKED_TOKENS.test(String(program || ''))) {
    throw new Error('candidate_program_uses_blocked_token');
  }
  const sandbox = Object.create(null);
  const script = new vm.Script(`"use strict";\n${program}\n;candidate;`);
  const candidate = script.runInNewContext(sandbox, { timeout: timeoutMs });
  if (typeof candidate !== 'function') {
    throw new Error('candidate_program_must_define_candidate_function');
  }
  return candidate;
}

function runCandidateTests(candidate, tests, timeoutMs) {
  let passed = 0;
  const results = tests.map((testCase) => {
    const script = new vm.Script('candidate(input)');
    const sandbox = Object.create(null);
    sandbox.candidate = candidate;
    sandbox.input = testCase.input;
    let actual;
    let ok = false;
    let error = '';
    try {
      actual = script.runInNewContext(sandbox, { timeout: timeoutMs });
      ok = Object.is(actual, testCase.expected);
    } catch (err) {
      error = err.message;
    }
    if (ok) passed += 1;
    return {
      input: testCase.input,
      expected: testCase.expected,
      actual,
      passed: ok,
      error,
    };
  });
  return {
    score: tests.length === 0 ? 0 : passed / tests.length,
    passed,
    total: tests.length,
    results,
  };
}

function evaluateCandidate(task, candidateSpec, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs || task.timeoutMs || 1000);
  const tests = asArray(task.tests);
  const program = String(candidateSpec.program || '');
  const candidateId = candidateSpec.id || stableId('candidate', program);
  const parentIds = asArray(candidateSpec.parentIds || candidateSpec.lineageParentIds);
  const issues = [];
  let evaluation = {
    score: 0,
    passed: 0,
    total: tests.length,
    results: [],
  };

  if (!task.id) issues.push('missing_evaluator_task_id');
  if (tests.length === 0) issues.push('missing_evaluator_tests');
  if (!program) issues.push('missing_candidate_program');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) issues.push('invalid_timeout');

  if (issues.length === 0) {
    try {
      const candidate = compileCandidate(program, timeoutMs);
      evaluation = runCandidateTests(candidate, tests, timeoutMs);
    } catch (err) {
      issues.push(err.message);
    }
  }

  const runId = `evaluator://${task.id || 'unknown'}/${candidateId}/${sha256(JSON.stringify({
    task,
    candidateId,
    program,
    evaluation,
    issues,
  })).slice(0, 12)}`;
  const scored = issues.length === 0;

  return {
    entryType: 'evaluator_candidate',
    taskId: task.id || '',
    candidateId,
    candidateProgramRef: `candidate://sha256/${sha256(program)}`,
    lineageParentIds: parentIds,
    evaluatorRun: {
      id: runId,
      timeoutMs,
      tests: tests.length,
    },
    score: evaluation.score,
    passed: evaluation.passed,
    total: evaluation.total,
    results: evaluation.results,
    issues,
    evidenceTypes: scored ? ['candidate_program', 'evaluator_run', 'score', 'lineage'] : ['candidate_program', 'evaluator_run'],
    promotionDecision: scored ? 'scored_candidate' : 'blocked_pending_score',
    groundingRefs: GROUNDING_REFS,
  };
}

function runEvaluatorLoop(input = {}, opts = {}) {
  const task = input.task || {};
  const candidates = asArray(input.candidates).map((candidate) => evaluateCandidate(task, candidate, opts));
  const retainTop = Math.max(1, Number(input.retainTop || opts.retainTop || 1));
  const retained = candidates
    .filter((candidate) => candidate.issues.length === 0)
    .sort((left, right) => right.score - left.score || left.candidateId.localeCompare(right.candidateId))
    .slice(0, retainTop);

  return {
    entryType: 'evaluator_loop',
    taskId: task.id || '',
    candidateCount: candidates.length,
    retained,
    candidates,
    status: retained.length > 0 ? 'retained_scored_candidates' : 'no_retained_candidates',
    groundingRefs: GROUNDING_REFS,
  };
}

module.exports = {
  GROUNDING_REFS,
  evaluateCandidate,
  runEvaluatorLoop,
};
