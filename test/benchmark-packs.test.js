'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const meridian = require('../lib/meridian-core');
const packs = require('../lib/benchmark-packs');
const evaluationHarness = require('../lib/evaluation-harness');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recall-benchmark-packs-'));
}

describe('project benchmark packs', () => {
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

  test('lists built-in Recall and Sensitive-domain benchmark packs', () => {
    expect(packs.listBenchmarkPacks()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'recall', taskCount: 3 }),
      expect.objectContaining({ id: 'sensitive-domain', taskCount: 3 }),
    ]));
  });

  test('imports Sensitive-domain pack tasks as clean time-sliced benchmarks', () => {
    const pack = packs.getBenchmarkPack('sensitive-domain');
    const tasks = pack.tasks.map((task) => evaluationHarness.addBenchmarkTask(kb, task));
    const stored = evaluationHarness.listBenchmarkTasks(kb, { project: 'sensitive-domain-project' });

    expect(tasks).toHaveLength(3);
    expect(stored.map((task) => task.id)).toEqual(expect.arrayContaining([
      'bench-sensitive-domain-publication-safety',
      'bench-sensitive-domain-dry-run-actions',
      'bench-sensitive-domain-terrain-import',
    ]));
    expect(stored.every((task) => task.contaminationStatus === 'clean')).toBe(true);
    expect(stored.every((task) => task.cutoffDate === '2026-05-04')).toBe(true);
  });

  test('builds pack answer batches that cover every task and can be scored', () => {
    const pack = packs.getBenchmarkPack('recall');
    pack.tasks.forEach((task) => evaluationHarness.addBenchmarkTask(kb, task));

    const answerBatch = packs.buildBenchmarkPackAnswers('recall', {
      modelCutoffDate: '2026-05-03',
      baselineScore: 0.2,
      runLabel: 'nightly-il',
    });
    const validation = packs.validateBenchmarkPackAnswers('recall', answerBatch);
    const result = evaluationHarness.recordBenchmarkBatch(kb, answerBatch);

    expect(validation).toMatchObject({
      valid: true,
      expectedTaskCount: 3,
      answerCount: 3,
      missingTaskIds: [],
      unknownTaskIds: [],
    });
    expect(answerBatch).toMatchObject({
      project: 'recall-dev',
      runLabel: 'nightly-il',
      baselineScore: 0.2,
    });
    expect(result).toMatchObject({
      status: 'completed',
      runCount: 3,
      passedCount: 3,
      failureCount: 0,
    });
    expect(result.averageDelta).toBeGreaterThan(0);
  });

  test('detects answer batches that drift from pack task coverage', () => {
    const validation = packs.validateBenchmarkPackAnswers('sensitive-domain', {
      answers: [
        { taskId: 'bench-sensitive-domain-publication-safety', answer: 'deny publication and require review' },
        { taskId: 'unknown-task', answer: 'nope' },
      ],
    });

    expect(validation).toMatchObject({
      valid: false,
      missingTaskIds: expect.arrayContaining([
        'bench-sensitive-domain-dry-run-actions',
        'bench-sensitive-domain-terrain-import',
      ]),
      unknownTaskIds: ['unknown-task'],
    });
  });

  test('rejects unknown benchmark packs', () => {
    expect(() => packs.getBenchmarkPack('missing')).toThrow(/Unknown benchmark pack/);
  });
});
