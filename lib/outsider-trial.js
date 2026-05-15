'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function defaultDataDir(root) {
  return path.join(root, '.codex-tmp', 'outsider-trial-data');
}

function defaultCliPath(root) {
  const sourceCli = path.join(root, 'bin', 'meridian.js');
  if (fs.existsSync(sourceCli)) return sourceCli;
  if (process.argv[1] && path.basename(process.argv[1]).toLowerCase() === 'meridian.js') {
    return process.argv[1];
  }
  return '';
}

function buildDisplayCommand(args, context = {}) {
  if (context.commandPrefix) return `${context.commandPrefix} ${args.join(' ')}`;
  if (context.sourceCheckout) return `node bin\\meridian.js ${args.join(' ')}`;
  return `recall ${args.join(' ')}`;
}

function buildCommand(root, id, args, context = {}) {
  const cliPath = context.cliPath || defaultCliPath(root);
  const command = cliPath
    ? [process.execPath, cliPath, ...args]
    : ['recall', ...args];
  return {
    id,
    cwd: root,
    command,
    display: buildDisplayCommand(args, context),
    expected: '',
  };
}

function buildOutsiderTrialPlan(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const dataDir = path.resolve(options.dataDir || defaultDataDir(root));
  const sourceCheckout = fs.existsSync(path.join(root, 'bin', 'meridian.js'));
  const commandContext = {
    cliPath: options.cliPath,
    commandPrefix: options.commandPrefix,
    sourceCheckout,
  };
  const commands = [
    {
      ...buildCommand(root, 'source-readiness', [
        'open-source',
        'readiness',
        '--stage',
        'limited-public',
        '--release-mode',
        'source',
        '--json',
      ], commandContext),
      expected: 'Readiness status is ready with zero blockers.',
    },
    {
      ...buildCommand(root, 'first-useful-workflow', [
        'feature',
        'example-run',
        'recall-project-health-brief',
        '--json',
      ], commandContext),
      expected: 'Feature example returns ok=true with healthy ledgers.',
    },
  ];
  return {
    id: options.id || 'source-only-outsider-trial',
    root,
    dataDir,
    releaseMode: 'source',
    stage: 'limited-public',
    goal: 'Test whether a new user can run the first useful Recall workflow without private context.',
    commandStyle: sourceCheckout ? 'source-checkout' : 'installed-cli',
    commands,
    comprehensionCheckpoints: [
      {
        id: 'purpose',
        prompt: 'After reading the README, what do you think Recall is for?',
        successSignal: 'User describes Recall as a local knowledge/feature lab, not a finished cloud product.',
      },
      {
        id: 'recall-meridian-split',
        prompt: 'What is the difference between Recall and Meridian in this release?',
        successSignal: 'User identifies Recall as local-first and Meridian as the later protocol/publication direction.',
      },
      {
        id: 'first-workflow-result',
        prompt: 'After running the feature example, what did the system prove?',
        successSignal: 'User can say the local feature manifest, capability review, ledger verification, and health check passed.',
      },
      {
        id: 'trust-boundary',
        prompt: 'What should not be trusted or promoted automatically?',
        successSignal: 'User names draft/imported/external knowledge or agent output as requiring evidence and promotion gates.',
      },
      {
        id: 'next-action',
        prompt: 'If something failed or confused you, where would you record it?',
        successSignal: 'User can turn failure/confusion into an issue, test, readiness finding, or trial note.',
      },
    ],
  };
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function summarizeCommand(id, parsed) {
  if (id === 'source-readiness') {
    return {
      status: parsed && parsed.summary ? parsed.summary.status : '',
      blockerCount: parsed && parsed.summary ? parsed.summary.blockerCount : null,
      warnCount: parsed && parsed.summary ? parsed.summary.warnCount : null,
      passed: Boolean(parsed && parsed.summary && parsed.summary.status === 'ready' && parsed.summary.blockerCount === 0),
    };
  }
  if (id === 'first-useful-workflow') {
    return {
      ok: parsed ? parsed.ok : null,
      example: parsed ? parsed.example : '',
      reviewStatus: parsed && parsed.review ? parsed.review.status : '',
      healthStatus: parsed && parsed.health ? parsed.health.status : '',
      passed: Boolean(parsed && parsed.ok === true && parsed.health && parsed.health.ok === true),
    };
  }
  return {
    passed: false,
  };
}

function defaultCommandRunner(command, context = {}) {
  return spawnSync(command.command[0], command.command.slice(1), {
    cwd: command.cwd,
    env: {
      ...process.env,
      MERIDIAN_DATA: context.dataDir,
    },
    encoding: 'utf8',
    windowsHide: true,
    timeout: context.timeoutMs || 120000,
    maxBuffer: 1024 * 1024 * 10,
  });
}

function runOutsiderTrial(options = {}) {
  const plan = buildOutsiderTrialPlan(options);
  if (!options.execute) {
    return {
      status: 'planned',
      ok: false,
      plan,
      commandResults: plan.commands.map((command) => ({
        id: command.id,
        display: command.display,
        status: 'not_run',
        expected: command.expected,
      })),
      evidenceGap: 'Run with --execute and collect a real new-user transcript before treating this as validation evidence.',
    };
  }

  fs.mkdirSync(plan.dataDir, { recursive: true });
  const runner = options.commandRunner || defaultCommandRunner;
  const commandResults = plan.commands.map((command) => {
    const result = runner(command, {
      dataDir: plan.dataDir,
      timeoutMs: options.timeoutMs,
    });
    const parsed = parseJson(result.stdout);
    const summary = summarizeCommand(command.id, parsed);
    return {
      id: command.id,
      display: command.display,
      expected: command.expected,
      status: result.status === 0 && summary.passed ? 'passed' : 'failed',
      exitCode: result.status,
      signal: result.signal || '',
      error: result.error ? result.error.message : '',
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      parsed,
      summary,
    };
  });
  const ok = commandResults.every((result) => result.status === 'passed');
  return {
    status: ok ? 'mechanical_pass' : 'mechanical_fail',
    ok,
    plan,
    commandResults,
    evidenceGap: ok
      ? 'Mechanical run passed. A real new-user comprehension transcript is still required before promoting readiness.'
      : 'Mechanical run failed. Convert failed commands into setup docs, tests, or readiness blockers.',
  };
}

function buildOutsiderTranscriptTemplate(options = {}) {
  const plan = buildOutsiderTrialPlan(options);
  return {
    schemaVersion: 'outsider-trial-transcript/v1',
    trialId: options.trialId || `${plan.id}-transcript`,
    outsiderId: options.outsiderId || '',
    conductedAt: options.conductedAt || '',
    mechanicalReportRef: options.mechanicalReportRef || '',
    answers: plan.comprehensionCheckpoints.map((checkpoint) => ({
      checkpointId: checkpoint.id,
      prompt: checkpoint.prompt,
      successSignal: checkpoint.successSignal,
      answer: '',
      understood: false,
      confusion: '',
      suggestedFix: '',
    })),
  };
}

function buildOutsiderTranscriptMarkdown(options = {}) {
  const template = buildOutsiderTranscriptTemplate(options);
  const lines = [
    '# Recall First-Run Walkthrough Transcript',
    '',
    `Trial ID: ${template.trialId}`,
    `Participant ID: ${template.outsiderId || '<fill in a non-sensitive id>'}`,
    `Conducted At: ${template.conductedAt || '<fill in ISO timestamp or date>'}`,
    `Mechanical Report Ref: ${template.mechanicalReportRef || '<fill in report path after running the mechanical trial>'}`,
    '',
    'Fill this out in your own words. The goal is not to sound polished; the goal is to reveal whether Recall is understandable without private context.',
    '',
  ];
  for (const answer of template.answers) {
    lines.push(`## ${answer.checkpointId}`);
    lines.push('');
    lines.push(`Prompt: ${answer.prompt}`);
    lines.push(`Success signal: ${answer.successSignal}`);
    lines.push('');
    lines.push('Answer:');
    lines.push('');
    lines.push('<write answer here>');
    lines.push('');
    lines.push('Understood: yes/no');
    lines.push('');
    lines.push('Confusion:');
    lines.push('');
    lines.push('<write confusion or leave blank>');
    lines.push('');
    lines.push('Suggested fix:');
    lines.push('');
    lines.push('<write suggested fix or leave blank>');
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function safeOutsiderId(value = '') {
  return String(value || 'outsider')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    || 'outsider';
}

function buildOutsiderTrialPacket(options = {}) {
  const plan = buildOutsiderTrialPlan(options);
  const outsiderId = safeOutsiderId(options.outsiderId);
  const outputDir = path.resolve(options.outputDir || path.join(plan.root, '.codex-tmp', 'outsider-trials', outsiderId));
  const reportPath = path.join(outputDir, 'mechanical-report.json');
  const transcriptPath = path.join(outputDir, 'transcript.json');
  const answerSheetPath = path.join(outputDir, 'transcript-answers.md');
  const evaluationPath = path.join(outputDir, 'transcript-evaluation.json');
  const transcript = buildOutsiderTranscriptTemplate({
    ...options,
    mechanicalReportRef: reportPath,
  });
  const answerSheet = buildOutsiderTranscriptMarkdown({
    ...options,
    mechanicalReportRef: reportPath,
  });
  const readme = [
    '# Recall First-Run Walkthrough Packet',
    '',
    'This packet is the standard first-run walkthrough for Recall. It helps a new user run the smallest useful workflow, answer comprehension checkpoints, and produce feedback that can be evaluated without private context.',
    '',
    '## Step 1 - Run Mechanical Trial',
    '',
    '```powershell',
    `${plan.commandStyle === 'source-checkout' ? 'node bin\\meridian.js' : 'recall'} open-source outsider-trial --execute --output "${reportPath}" --transcript-output "${transcriptPath}" --outsider-id "${transcript.outsiderId}"`,
    '```',
    '',
    '## Step 2 - Fill Transcript',
    '',
    `Fill in ${transcriptPath}. The human-readable prompts are also copied to ${answerSheetPath}.`,
    '',
    'Required rule: answer in your own words. Do not mark understood=true unless you genuinely understood the checkpoint.',
    '',
    '## Step 3 - Evaluate Transcript',
    '',
    '```powershell',
    `${plan.commandStyle === 'source-checkout' ? 'node bin\\meridian.js' : 'recall'} open-source outsider-transcript "${transcriptPath}" --mechanical-report "${reportPath}" --output "${evaluationPath}" --json`,
    '```',
    '',
    '## Passing Signal',
    '',
    'The evaluation should return ok=true and status=outsider_validated. If it does not, treat the findings as documentation, setup, or architecture feedback.',
    '',
  ].join('\n');
  return {
    schemaVersion: 'outsider-trial-packet/v1',
    ok: true,
    plan,
    outsiderId,
    outputDir,
    files: {
      readme: path.join(outputDir, 'README.md'),
      mechanicalReport: reportPath,
      transcript: transcriptPath,
      answerSheet: answerSheetPath,
      evaluation: evaluationPath,
    },
    transcript,
    answerSheet,
    readme: `${readme}\n`,
    commands: [
      {
        id: 'run-mechanical-trial',
        command: `${plan.commandStyle === 'source-checkout' ? 'node bin\\meridian.js' : 'recall'} open-source outsider-trial --execute --output "${reportPath}" --transcript-output "${transcriptPath}" --outsider-id "${transcript.outsiderId}"`,
      },
      {
        id: 'evaluate-transcript',
        command: `${plan.commandStyle === 'source-checkout' ? 'node bin\\meridian.js' : 'recall'} open-source outsider-transcript "${transcriptPath}" --mechanical-report "${reportPath}" --output "${evaluationPath}" --json`,
      },
    ],
  };
}

function writeOutsiderTrialPacket(options = {}) {
  const packet = buildOutsiderTrialPacket(options);
  fs.mkdirSync(packet.outputDir, { recursive: true });
  fs.writeFileSync(packet.files.readme, packet.readme);
  fs.writeFileSync(packet.files.transcript, `${JSON.stringify(packet.transcript, null, 2)}\n`);
  fs.writeFileSync(packet.files.answerSheet, packet.answerSheet);
  return {
    ...packet,
    written: [
      packet.files.readme,
      packet.files.transcript,
      packet.files.answerSheet,
    ],
  };
}

function readJsonFile(filePath) {
  const resolved = path.resolve(filePath);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function answerFor(transcript, checkpointId) {
  return (transcript.answers || []).find((answer) => (
    answer.checkpointId === checkpointId || answer.id === checkpointId
  ));
}

function evaluateOutsiderTranscript(transcriptInput, options = {}) {
  const transcript = typeof transcriptInput === 'string' ? readJsonFile(transcriptInput) : transcriptInput;
  const plan = buildOutsiderTrialPlan(options);
  const mechanicalReport = options.mechanicalReport
    || (options.mechanicalReportPath ? readJsonFile(options.mechanicalReportPath) : null);
  const mechanicalOk = mechanicalReport ? mechanicalReport.ok === true : false;
  const findings = [];
  const checkpointResults = plan.comprehensionCheckpoints.map((checkpoint) => {
    const answer = answerFor(transcript || {}, checkpoint.id);
    const answerText = answer && typeof answer.answer === 'string' ? answer.answer.trim() : '';
    const confusion = answer && typeof answer.confusion === 'string' ? answer.confusion.trim() : '';
    const understood = Boolean(answer && answer.understood === true);
    const passed = Boolean(answerText && understood && !confusion);
    if (!answerText) {
      findings.push({
        id: `missing-answer:${checkpoint.id}`,
        severity: 'blocker',
        checkpointId: checkpoint.id,
        title: 'Outsider transcript is missing a checkpoint answer.',
        remediation: 'Ask the outsider to answer this checkpoint in their own words.',
      });
    } else if (!understood || confusion) {
      findings.push({
        id: `outsider-confusion:${checkpoint.id}`,
        severity: 'warn',
        checkpointId: checkpoint.id,
        title: 'Outsider comprehension needs follow-up.',
        detail: confusion || answerText,
        remediation: answer && answer.suggestedFix
          ? answer.suggestedFix
          : 'Convert this confusion into a README, setup, command-output, or UX improvement.',
      });
    }
    return {
      checkpointId: checkpoint.id,
      prompt: checkpoint.prompt,
      successSignal: checkpoint.successSignal,
      answered: Boolean(answerText),
      understood,
      confusion,
      passed,
    };
  });
  if (!transcript || !transcript.outsiderId) {
    findings.push({
      id: 'missing-outsider-id',
      severity: 'blocker',
      title: 'Transcript is missing outsider identity.',
      remediation: 'Record a non-sensitive outsider identifier so the trial is auditable.',
    });
  }
  if (mechanicalReport && !mechanicalOk) {
    findings.push({
      id: 'mechanical-trial-not-passing',
      severity: 'blocker',
      title: 'Mechanical trial report did not pass.',
      remediation: 'Fix mechanical setup or feature workflow failures before treating comprehension as readiness evidence.',
    });
  }
  const blockerCount = findings.filter((finding) => finding.severity === 'blocker').length;
  const warnCount = findings.filter((finding) => finding.severity === 'warn').length;
  const allCheckpointsPassed = checkpointResults.every((checkpoint) => checkpoint.passed);
  const status = blockerCount > 0
    ? 'incomplete'
    : allCheckpointsPassed && (!mechanicalReport || mechanicalOk)
      ? 'outsider_validated'
      : 'needs_followup';
  return {
    schemaVersion: 'outsider-trial-evaluation/v1',
    status,
    ok: status === 'outsider_validated',
    trialId: transcript && transcript.trialId ? transcript.trialId : '',
    outsiderId: transcript && transcript.outsiderId ? transcript.outsiderId : '',
    conductedAt: transcript && transcript.conductedAt ? transcript.conductedAt : '',
    mechanicalReportRef: transcript && transcript.mechanicalReportRef ? transcript.mechanicalReportRef : '',
    mechanicalOk,
    checkpointResults,
    findings,
    summary: {
      status,
      blockerCount,
      warnCount,
      checkpointCount: checkpointResults.length,
      passedCheckpointCount: checkpointResults.filter((checkpoint) => checkpoint.passed).length,
    },
    promotionDecision: status === 'outsider_validated'
      ? 'candidate_outsider_evidence'
      : 'blocked_pending_outsider_followup',
  };
}

module.exports = {
  buildOutsiderTrialPlan,
  buildOutsiderTrialPacket,
  buildOutsiderTranscriptMarkdown,
  buildOutsiderTranscriptTemplate,
  defaultDataDir,
  evaluateOutsiderTranscript,
  runOutsiderTrial,
  summarizeCommand,
  writeOutsiderTrialPacket,
};
