'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  buildOutsiderTrialPlan,
  buildOutsiderTrialPacket,
  buildOutsiderTranscriptTemplate,
  evaluateOutsiderTranscript,
  runOutsiderTrial,
  summarizeCommand,
  writeOutsiderTrialPacket,
} = require('../lib/outsider-trial');

describe('source-only outsider trial harness', () => {
  function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'outsider-trial-'));
  }

  test('plans the first useful workflow and comprehension checkpoints without executing', () => {
    const root = path.join('C:', 'workspace', 'recall-cli');
    const report = runOutsiderTrial({ root });

    expect(report.status).toBe('planned');
    expect(report.plan.commands.map((command) => command.id)).toEqual([
      'source-readiness',
      'first-useful-workflow',
    ]);
    expect(report.commandResults.every((result) => result.status === 'not_run')).toBe(true);
    expect(report.plan.comprehensionCheckpoints.map((checkpoint) => checkpoint.id)).toEqual(expect.arrayContaining([
      'purpose',
      'recall-meridian-split',
      'first-workflow-result',
      'trust-boundary',
      'next-action',
    ]));
  });

  test('summarizes readiness and feature workflow command outputs', () => {
    expect(summarizeCommand('source-readiness', {
      summary: {
        status: 'ready',
        blockerCount: 0,
        warnCount: 3,
      },
    })).toMatchObject({
      passed: true,
      blockerCount: 0,
    });
    expect(summarizeCommand('first-useful-workflow', {
      ok: true,
      example: 'recall-project-health-brief',
      review: { status: 'allowed' },
      health: { ok: true, status: 'healthy' },
    })).toMatchObject({
      passed: true,
      ok: true,
      healthStatus: 'healthy',
    });
  });

  test('executes through an injected command runner and reports mechanical pass', () => {
    const root = tempDir();
    const calls = [];
    try {
      const report = runOutsiderTrial({
        root,
        execute: true,
        commandRunner(command, context) {
          calls.push({ command, context });
          if (command.id === 'source-readiness') {
            return {
              status: 0,
              stdout: JSON.stringify({ summary: { status: 'ready', blockerCount: 0, warnCount: 2 } }),
              stderr: '',
            };
          }
          return {
            status: 0,
            stdout: JSON.stringify({
              ok: true,
              example: 'recall-project-health-brief',
              review: { status: 'allowed' },
              health: { ok: true, status: 'healthy' },
            }),
            stderr: '',
          };
        },
      });

      expect(report.status).toBe('mechanical_pass');
      expect(report.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0].context.dataDir).toContain('outsider-trial-data');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed when a mechanical command does not pass expected output', () => {
    const plan = buildOutsiderTrialPlan({ root: process.cwd() });
    expect(plan.releaseMode).toBe('source');

    const report = runOutsiderTrial({
      root: process.cwd(),
      execute: true,
      commandRunner(command) {
        return {
          status: command.id === 'source-readiness' ? 0 : 1,
          stdout: command.id === 'source-readiness'
            ? JSON.stringify({ summary: { status: 'ready', blockerCount: 0 } })
            : '',
          stderr: command.id === 'source-readiness' ? '' : 'feature failed',
        };
      },
    });

    expect(report.status).toBe('mechanical_fail');
    expect(report.ok).toBe(false);
    expect(report.commandResults.find((result) => result.id === 'first-useful-workflow')).toMatchObject({
      status: 'failed',
      stderr: 'feature failed',
    });
  });

  test('builds an outsider transcript template from comprehension checkpoints', () => {
    const template = buildOutsiderTranscriptTemplate({
      root: process.cwd(),
      outsiderId: 'tester',
      mechanicalReportRef: '.codex-tmp/outsider-trial-report.json',
    });

    expect(template.schemaVersion).toBe('outsider-trial-transcript/v1');
    expect(template.outsiderId).toBe('tester');
    expect(template.answers).toHaveLength(5);
    expect(template.answers[0]).toMatchObject({
      checkpointId: 'purpose',
      answer: '',
      understood: false,
    });
  });

  test('builds a fillable outsider trial packet around the transcript workflow', () => {
    const root = path.join('C:', 'workspace', 'recall-cli');
    const packet = buildOutsiderTrialPacket({
      root,
      outsiderId: 'Tester Trial',
    });

    expect(packet.schemaVersion).toBe('outsider-trial-packet/v1');
    expect(packet.outsiderId).toBe('tester-trial');
    expect(packet.outputDir).toBe(path.join(path.resolve(root), '.codex-tmp', 'outsider-trials', 'tester-trial'));
    expect(packet.files.readme).toBe(path.join(packet.outputDir, 'README.md'));
    expect(packet.transcript.outsiderId).toBe('Tester Trial');
    expect(packet.transcript.answers).toHaveLength(5);
    expect(packet.answerSheet).toContain('## purpose');
    expect(packet.readme).toContain('Step 1 - Run Mechanical Trial');
    expect(packet.commands.map((command) => command.id)).toEqual([
      'run-mechanical-trial',
      'evaluate-transcript',
    ]);
  });

  test('writes outsider trial packet files without running the trial', () => {
    const root = tempDir();
    try {
      const packet = writeOutsiderTrialPacket({
        root,
        outsiderId: 'tester',
      });
      const outputDir = path.join(root, '.codex-tmp', 'outsider-trials', 'tester');

      expect(packet.written).toEqual([
        path.join(outputDir, 'README.md'),
        path.join(outputDir, 'transcript.json'),
        path.join(outputDir, 'transcript-answers.md'),
      ]);
      expect(fs.existsSync(path.join(outputDir, 'README.md'))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, 'transcript.json'))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, 'transcript-answers.md'))).toBe(true);
      const transcript = JSON.parse(fs.readFileSync(path.join(outputDir, 'transcript.json'), 'utf8'));
      expect(transcript.outsiderId).toBe('tester');
      expect(transcript.answers.every((answer) => answer.answer === '')).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('evaluates a passing outsider transcript as candidate evidence', () => {
    const template = buildOutsiderTranscriptTemplate({ root: process.cwd(), outsiderId: 'tester' });
    const transcript = {
      ...template,
      conductedAt: '2026-05-04T00:00:00.000Z',
      answers: template.answers.map((answer) => ({
        ...answer,
        answer: `Answer for ${answer.checkpointId}`,
        understood: true,
      })),
    };

    const report = evaluateOutsiderTranscript(transcript, {
      root: process.cwd(),
      mechanicalReport: { ok: true },
    });

    expect(report.status).toBe('outsider_validated');
    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({
      blockerCount: 0,
      warnCount: 0,
      passedCheckpointCount: 5,
    });
    expect(report.promotionDecision).toBe('candidate_outsider_evidence');
  });

  test('turns outsider confusion into readiness findings without passing validation', () => {
    const template = buildOutsiderTranscriptTemplate({ root: process.cwd(), outsiderId: 'tester' });
    const transcript = {
      ...template,
      answers: template.answers.map((answer, index) => ({
        ...answer,
        answer: index === 0 ? 'I think it is a cloud database.' : `Answer for ${answer.checkpointId}`,
        understood: index !== 0,
        confusion: index === 0 ? 'README made Recall sound hosted.' : '',
        suggestedFix: index === 0 ? 'Clarify local-first in the first paragraph.' : '',
      })),
    };

    const report = evaluateOutsiderTranscript(transcript, {
      root: process.cwd(),
      mechanicalReport: { ok: true },
    });

    expect(report.status).toBe('needs_followup');
    expect(report.ok).toBe(false);
    expect(report.findings.find((finding) => finding.id === 'outsider-confusion:purpose')).toMatchObject({
      severity: 'warn',
      remediation: 'Clarify local-first in the first paragraph.',
    });
  });

  test('requires a transcript path in the CLI unless template mode is used', () => {
    const report = evaluateOutsiderTranscript({
      schemaVersion: 'outsider-trial-transcript/v1',
      outsiderId: '',
      answers: [],
    }, { root: process.cwd() });

    expect(report.status).toBe('incomplete');
    expect(report.findings.map((finding) => finding.id)).toEqual(expect.arrayContaining([
      'missing-outsider-id',
      'missing-answer:purpose',
    ]));
  });

});
