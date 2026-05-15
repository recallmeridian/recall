'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const meridian = require('../lib/meridian-core');
const benchmarkExpander = require('../lib/benchmark-expander');
const intelligenceArtifacts = require('../lib/intelligence-artifacts');
const evaluationHarness = require('../lib/evaluation-harness');
const agentHandoffs = require('../lib/agent-handoff-ledger');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recall-benchmark-expander-'));
}

describe('benchmark expander', () => {
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

  test('generates benchmark tasks from failures outcomes and handoffs', () => {
    intelligenceArtifacts.storeArtifact(kb, {
      entryType: 'anti_pattern',
      id: 'anti-pattern-missing-evidence',
      failureType: 'missing_evidence',
      repairStrategy: 'require source evidence before promotion',
      groundingRefs: ['reflexion-2023-verbal-rl'],
    }, { project: 'recall-dev', type: 'anti_pattern', id: 'anti-pattern-missing-evidence' });
    intelligenceArtifacts.storeArtifact(kb, {
      entryType: 'recommendation_outcome',
      recommendationRef: 'cycle://recall-dev/demo/overall',
      outcome: 'harmful',
      actual: 'Skipped benchmark checks and shipped a regression.',
      evidenceRefs: ['test:regression'],
      status: 'observed',
    }, { project: 'recall-dev', type: 'recommendation_outcome', id: 'outcome-harmful-demo' });
    intelligenceArtifacts.storeArtifact(kb, {
      entryType: 'agent_handoff_hard_case',
      id: 'hard-case-reviewer-demo',
      failureSignal: 'review missed missing verifier evidence',
      draftLesson: 'require verifier evidence before accepting formal claims',
      agentId: 'adversarial-reviewer',
    }, { project: 'recall-dev', type: 'agent_handoff_hard_case', id: 'hard-case-reviewer-demo' });
    agentHandoffs.recordHandoff(kb, {
      project: 'recall-dev',
      agentId: 'implementation-builder',
      taskType: 'implementation',
      taskSummary: 'Build risky benchmark expander.',
      selectedBecause: 'Implementation slice.',
      evidenceRefs: ['human:test'],
      expectedOutputs: ['code'],
      actualOutputs: [],
      acceptanceCriteria: ['guardrail generated'],
      failureSignals: ['benchmark task lacked outcome evidence'],
      draftLessons: ['require outcome evidence before benchmark expansion trust'],
      outcome: 'blocked',
      promotionRecommendation: 'raw_handoff',
    });

    const result = benchmarkExpander.expandBenchmarks(kb, {
      project: 'recall-dev',
      cutoffDate: '2026-05-04',
      storeArtifact: true,
    });
    const tasks = evaluationHarness.listBenchmarkTasks(kb, { project: 'recall-dev' });
    const expansionRuns = intelligenceArtifacts.listArtifacts(kb, {
      project: 'recall-dev',
      type: 'benchmark_expansion_run',
    });

    expect(result).toMatchObject({
      entryType: 'benchmark_expansion_run',
      status: 'expanded',
      taskCount: 4,
      storedTaskCount: 4,
    });
    expect(tasks).toHaveLength(4);
    expect(tasks.map((task) => task.expected)).toEqual(expect.arrayContaining([
      'require source evidence before promotion',
      expect.stringContaining('do not repeat recommendation'),
      'require verifier evidence before accepting formal claims',
      'require outcome evidence before benchmark expansion trust',
    ]));
    expect(expansionRuns).toHaveLength(1);
  });

  test('dry-run returns generated tasks without storing them', () => {
    intelligenceArtifacts.storeArtifact(kb, {
      entryType: 'anti_pattern',
      id: 'anti-pattern-timeout',
      failureType: 'execution_timeout',
      repairStrategy: 'split long work into checkpointed steps',
    }, { project: 'recall-dev', type: 'anti_pattern', id: 'anti-pattern-timeout' });

    const result = benchmarkExpander.expandBenchmarks(kb, {
      project: 'recall-dev',
      cutoffDate: '2026-05-04',
      from: ['failures'],
      dryRun: true,
    });

    expect(result).toMatchObject({
      taskCount: 1,
      storedTaskCount: 0,
    });
    expect(evaluationHarness.listBenchmarkTasks(kb, { project: 'recall-dev' })).toHaveLength(0);
  });
});
