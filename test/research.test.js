'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const meridian = require('../lib/meridian-core');
const research = require('../lib/research');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-research-'));
}

describe('research attempt port helpers', () => {
  let dir;
  let kb;

  beforeEach(() => {
    dir = tempDir();
    kb = meridian.init(dir);
  });

  afterEach(() => {
    if (kb) kb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('ensures a research project and adds a problem candidate', () => {
    const problem = research.addProblem(kb, 'erdos-vibe', {
      id: 'erdos-1',
      title: 'Toy Erdos Problem',
      statement: 'Prove a toy primitive-set statement.',
      tags: ['number-theory'],
    });

    expect(problem.id).toBe('erdos-1');
    expect(problem.category).toBe('research-problem');
    expect(problem.status).toBe('draft');
    expect(problem._extensions.researchType).toBe('problem');
    expect(problem._extensions.workflow).toHaveLength(8);
    expect(problem._extensions.workflow[0].status).toBe('in_progress');
    expect(kb.listProjects().some((project) => project.id === 'erdos-vibe')).toBe(true);
  });

  test('parses JSONL traces without mutating the source file', () => {
    const tracePath = path.join(dir, 'trace.jsonl');
    const raw = [
      JSON.stringify({ tactic: 'intro n', premise: 'Nat.succ_eq_add_one' }),
      JSON.stringify({ selected_tactic: 'simp', lemmas_used: ['Nat.zero_add'] }),
      'not json',
    ].join('\n');
    fs.writeFileSync(tracePath, raw);

    const summary = research.parseJsonlTrace(tracePath);

    expect(summary.lineCount).toBe(3);
    expect(summary.parsedCount).toBe(2);
    expect(summary.parseErrors).toHaveLength(1);
    expect(summary.tacticCount).toBe(2);
    expect(summary.lemmas).toContain('Nat.zero_add');
    expect(fs.readFileSync(tracePath, 'utf8')).toBe(raw);
  });

  test('ingests a verifier trace as an attempt and summarizes status', () => {
    research.addProblem(kb, 'erdos-vibe', {
      id: 'erdos-2',
      title: 'Second Toy Problem',
      statement: 'A second problem.',
    });

    const tracePath = path.join(dir, 'attempt.jsonl');
    fs.writeFileSync(tracePath, JSON.stringify({ tactic: 'exact trivial' }) + '\n');

    const attempt = research.ingestTrace(kb, 'erdos-vibe', {
      problemId: 'erdos-2',
      tracePath,
      adapter: 'ulamai',
      verifier: 'lean4',
      status: 'partial',
    });

    expect(attempt.category).toBe('research-attempt');
    expect(attempt._extensions.parentProblemId).toBe('erdos-2');
    expect(attempt._extensions.trace.lineCount).toBe(1);

    const status = research.getResearchStatus(kb, 'erdos-vibe');
    expect(status.counts.problems).toBe(1);
    expect(status.counts.attempts).toBe(1);
    expect(status.counts.partial).toBe(1);
  });

  test('promotes an attempt only through the explicit promotion path', () => {
    research.addProblem(kb, 'erdos-vibe', {
      id: 'erdos-3',
      title: 'Third Toy Problem',
      statement: 'A third problem.',
    });

    const tracePath = path.join(dir, 'verified.jsonl');
    fs.writeFileSync(tracePath, JSON.stringify({ tactic: 'rfl' }) + '\n');

    const attempt = research.ingestTrace(kb, 'erdos-vibe', {
      problemId: 'erdos-3',
      tracePath,
      adapter: 'ulamai',
      verifier: 'lean4',
      status: 'partial',
      driftStatus: 'clear',
    });

    const promoted = research.promoteAttempt(kb, 'erdos-vibe', attempt.id, 'Lean accepted the artifact.');

    expect(promoted.status).toBe('active');
    expect(promoted.confidence.verificationStatus).toBe('verified');
    expect(promoted._extensions.attemptStatus).toBe('verified');
    expect(promoted._extensions.promotionNotes).toContain('Lean accepted');
  });

  test('workflow next checks off a step and advances', () => {
    research.addProblem(kb, 'erdos-vibe', {
      id: 'erdos-4',
      title: 'Fourth Toy Problem',
      statement: 'A fourth problem.',
    });

    const result = research.completeWorkflowStep(
      kb,
      'erdos-vibe',
      'erdos-4',
      '',
      'Found a trustworthy open-problem source.'
    );

    expect(result.completed.id).toBe('find-problem');
    expect(result.completed.status).toBe('done');
    expect(result.next.id).toBe('create-problem');
    expect(result.next.status).toBe('in_progress');

    const workflow = research.getWorkflow(kb, 'erdos-vibe', 'erdos-4');
    expect(workflow[0].notes).toContain('trustworthy');
    expect(workflow[1].status).toBe('in_progress');
  });

  test('workflow step can be blocked manually', () => {
    research.addProblem(kb, 'erdos-vibe', {
      id: 'erdos-5',
      title: 'Fifth Toy Problem',
      statement: 'A fifth problem.',
    });

    const updated = research.setWorkflowStep(
      kb,
      'erdos-vibe',
      'erdos-5',
      'verify',
      'blocked',
      'Need a formal statement first.'
    );

    const verify = updated._extensions.workflow.find((step) => step.id === 'verify');
    expect(verify.status).toBe('blocked');
    expect(verify.notes).toContain('formal statement');
  });
});
