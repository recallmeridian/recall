'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const meridian = require('../lib/meridian-core');
const evaluationHarness = require('../lib/evaluation-harness');
const promotionGates = require('../lib/promotion-gates');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recall-evaluation-harness-'));
}

describe('Recall evaluation harness MVP', () => {
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

  test('adds a time-sliced benchmark task and records baseline delta', () => {
    const task = evaluationHarness.addBenchmarkTask(kb, {
      id: 'bench-lesson-transfer',
      project: 'recall-dev',
      title: 'Lesson transfer fixture',
      prompt: 'Name the required promotion evidence for a skill.',
      expected: 'source trace and evaluation evidence',
      cutoffDate: '2026-05-01',
      tags: ['trace-to-skill'],
      groundingRefs: ['lemmabench-2026-live-research-level-math'],
    });
    const run = evaluationHarness.recordBenchmarkRun(kb, task.id, {
      answer: 'A skill needs a source trace and evaluation evidence.',
      baselineScore: 0.25,
      modelCutoffDate: '2026-04-01',
      runLabel: 'recall-assisted',
    });

    expect(task).toMatchObject({
      contaminationStatus: 'clean',
      cutoffDate: '2026-05-01',
    });
    expect(run.passed).toBe(true);
    expect(run.delta).toBeGreaterThan(0);
    expect(run.passThreshold).toBe(0.75);
    expect(run.evidenceRef).toContain('benchmark://bench-lesson-transfer/recall-assisted/');
    expect(run.evidenceTypes).toEqual(expect.arrayContaining([
      'benchmark_task',
      'baseline',
      'run_result',
      'contamination_check',
      'evaluation_evidence',
    ]));
    expect(run.evidenceRecord).toMatchObject({
      entryType: 'benchmark_result',
      promotionDecision: 'evaluation_evidence',
    });
    expect(run.entryType).toBe('benchmark_result');
    expect(promotionGates.evaluatePromotionGate(run)).toMatchObject({
      allowed: true,
      entryType: 'benchmark_result',
    });
    expect(run.groundingRefs).toEqual(['lemmabench-2026-live-research-level-math']);
  });

  test('blocks contaminated tasks from producing evaluation evidence', () => {
    const task = evaluationHarness.addBenchmarkTask(kb, {
      id: 'bench-contaminated',
      project: 'recall-dev',
      title: 'Contaminated fixture',
      prompt: 'Known leaked prompt',
      expected: 'known answer',
      cutoffDate: '2026-05-01',
      contaminationStatus: 'contaminated',
    });

    expect(() => evaluationHarness.recordBenchmarkRun(kb, task.id, {
      answer: 'known answer',
      baselineScore: 0,
      modelCutoffDate: '2026-04-01',
    })).toThrow(/not clean/i);
    expect(evaluationHarness.listBenchmarkRuns(kb, {})).toHaveLength(0);
  });

  test('scores exact, partial, and empty answers deterministically', () => {
    expect(evaluationHarness.scoreAnswer('alpha beta', 'alpha beta')).toBe(1);
    expect(evaluationHarness.scoreAnswer('alpha beta with explanation', 'alpha beta')).toBe(1);
    expect(evaluationHarness.scoreAnswer('alpha', 'alpha beta')).toBe(0.75);
    expect(evaluationHarness.scoreAnswer('', 'alpha beta')).toBe(0);
  });

  test('requires baseline score and model cutoff before recording a run', () => {
    const task = evaluationHarness.addBenchmarkTask(kb, {
      id: 'bench-requires-controls',
      project: 'recall-dev',
      title: 'Control fixture',
      prompt: 'Controlled?',
      expected: 'yes',
      cutoffDate: '2026-05-01',
    });

    expect(() => evaluationHarness.recordBenchmarkRun(kb, task.id, {
      answer: 'yes',
      modelCutoffDate: '2026-04-01',
    })).toThrow(/baseline/i);
    expect(() => evaluationHarness.recordBenchmarkRun(kb, task.id, {
      answer: 'yes',
      baselineScore: 0,
    })).toThrow(/model cutoff/i);
    expect(() => evaluationHarness.recordBenchmarkRun(kb, task.id, {
      answer: 'yes',
      baselineScore: 0,
      modelCutoffDate: '2026-05-01',
    })).toThrow(/not before/i);
    expect(() => evaluationHarness.recordBenchmarkRun(kb, task.id, {
      answer: 'yes',
      baselineScore: null,
      modelCutoffDate: '2026-04-01',
    })).toThrow(/baseline/i);
    expect(() => evaluationHarness.recordBenchmarkRun(kb, task.id, {
      answer: 'yes',
      baselineScore: 0,
      modelCutoffDate: 'April 1, 2026',
    })).toThrow(/YYYY-MM-DD/i);
  });

  test('score override requires and persists verifier reference', () => {
    const task = evaluationHarness.addBenchmarkTask(kb, {
      id: 'bench-score-override',
      project: 'recall-dev',
      title: 'Score override fixture',
      prompt: 'Override?',
      expected: 'yes',
      cutoffDate: '2026-05-01',
    });

    expect(() => evaluationHarness.recordBenchmarkRun(kb, task.id, {
      answer: '',
      score: 1,
      baselineScore: 0,
      modelCutoffDate: '2026-04-01',
    })).toThrow(/verifierRef/i);

    const run = evaluationHarness.recordBenchmarkRun(kb, task.id, {
      answer: '',
      score: 1,
      baselineScore: 0,
      modelCutoffDate: '2026-04-01',
      verifierRef: 'verifier://manual/score-override',
    });
    const [stored] = evaluationHarness.listBenchmarkRuns(kb, { taskId: task.id });

    expect(run.verifierRef).toBe('verifier://manual/score-override');
    expect(stored.verifierRef).toBe('verifier://manual/score-override');
  });

  test('records a batch of benchmark answers with shared controls', () => {
    evaluationHarness.addBenchmarkTask(kb, {
      id: 'bench-batch-one',
      project: 'recall-dev',
      title: 'Batch one',
      prompt: 'One?',
      expected: 'yes',
      cutoffDate: '2026-05-01',
    });
    evaluationHarness.addBenchmarkTask(kb, {
      id: 'bench-batch-two',
      project: 'recall-dev',
      title: 'Batch two',
      prompt: 'Two?',
      expected: 'source trace and evaluation evidence',
      cutoffDate: '2026-05-01',
    });

    const result = evaluationHarness.recordBenchmarkBatch(kb, {
      project: 'recall-dev',
      modelCutoffDate: '2026-04-01',
      baselineScore: 0.25,
      answers: [
        { taskId: 'bench-batch-one', answer: 'yes' },
        { taskId: 'bench-batch-two', answer: 'source trace and evaluation evidence' },
      ],
    });

    expect(result).toMatchObject({
      entryType: 'benchmark_batch_run',
      status: 'completed',
      answerCount: 2,
      runCount: 2,
      passedCount: 2,
      failureCount: 0,
      promotionDecision: 'evaluation_batch_recorded',
    });
    expect(result.averageScore).toBe(1);
    expect(evaluationHarness.listBenchmarkRuns(kb, { project: 'recall-dev' })).toHaveLength(2);
  });

  test('batch runs preserve per-task failures without hiding successful runs', () => {
    evaluationHarness.addBenchmarkTask(kb, {
      id: 'bench-batch-ok',
      project: 'recall-dev',
      title: 'Batch ok',
      prompt: 'Ok?',
      expected: 'yes',
      cutoffDate: '2026-05-01',
    });

    const result = evaluationHarness.recordBenchmarkBatch(kb, {
      project: 'recall-dev',
      modelCutoffDate: '2026-04-01',
      baselineScore: 0,
      answers: [
        { taskId: 'bench-batch-ok', answer: 'yes' },
        { taskId: 'bench-batch-missing', answer: 'yes' },
      ],
    });

    expect(result).toMatchObject({
      status: 'completed_with_failures',
      runCount: 1,
      failureCount: 1,
      promotionDecision: 'blocked_pending_benchmark_repairs',
    });
    expect(result.failures[0].error).toContain('Benchmark task not found');
  });
});
