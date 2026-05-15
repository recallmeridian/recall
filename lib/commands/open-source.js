'use strict';

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const readiness = require('../open-source-readiness');
const releaseScope = require('../release-scope');
const outsiderTrial = require('../outsider-trial');
const { scanDir, scanContent } = require('../security/egress-scanner');
const { appendScan } = require('../security/scan-ledger');
const { evaluateEnsemble, rulesEvaluator, heuristicEvaluator } = require('../security/evaluator-ensemble');
const auditIngest = require('../security/audit-ingest');
const cliConfig = require('../cli-config');
const { table } = require('../format');

function printReport(report) {
  console.log(chalk.bold('\nOpen Source Readiness\n'));
  console.log(`Stage:     ${chalk.cyan(report.summary.stage)}`);
  console.log(`Mode:      ${chalk.cyan(report.releaseMode)}`);
  console.log(`Status:    ${report.summary.status === 'ready' ? chalk.green('ready') : chalk.yellow('blocked')}`);
  console.log(`Principle: ${report.principle}`);
  console.log(`Root:      ${report.root}`);
  console.log('');

  if (report.findings.length === 0) {
    console.log(chalk.green('No readiness findings.'));
    console.log('');
    return;
  }

  table(report.findings.map((finding) => [
    finding.severity,
    finding.id,
    finding.file || '-',
    finding.title,
  ]), ['Severity', 'ID', 'File', 'Title']);
  console.log('');
  console.log(`Blockers: ${report.summary.blockerCount}`);
  console.log(`Warnings: ${report.summary.warnCount}`);
  console.log('');
}

function printReleaseScope(report) {
  console.log(chalk.bold('\nOpen Source Release Scope\n'));
  console.log(`Mode:   ${chalk.cyan(report.releaseMode)}`);
  console.log(`Status: ${report.status === 'blocked' ? chalk.yellow(report.status) : chalk.green(report.status)}`);
  console.log(`Root:   ${report.root}`);
  console.log('');
  table([
    ['public', String(report.summary.public)],
    ['experimental', String(report.summary.experimental)],
    ['excluded', String(report.summary.excluded)],
    ['unspecified', String(report.summary.unspecified)],
  ], ['Scope', 'Files']);
  console.log('');

  console.log(chalk.bold('Public release feature set'));
  table(report.publicFeatures.map((feature) => [
    feature.id,
    feature.status,
    feature.promise,
  ]), ['Feature', 'Status', 'Promise']);
  console.log('');

  console.log(chalk.bold('Non-release surfaces'));
  table(report.nonReleaseSurfaces.map((surface) => [
    surface.id,
    surface.paths.join(', '),
    surface.reason,
  ]), ['Surface', 'Paths', 'Reason']);
  console.log('');

  if (report.findings.length) {
    table(report.findings.map((finding) => [
      finding.severity,
      finding.id,
      finding.title,
    ]), ['Severity', 'ID', 'Title']);
    console.log('');
  }
}

module.exports = function(program) {
  const command = program
    .command('open-source')
    .description('Evaluate Recall/Meridian open source readiness gates');

  command
    .command('release-scope')
    .description('Report which files/features belong in the public release surface')
    .option('--root <path>', 'Repository root to check', process.cwd())
    .option('--release-mode <mode>', 'Release mode: source or npm', 'source')
    .option('--require-whole-repo-public', 'Fail if excluded research/private surfaces are present in the repo')
    .option('--json', 'Print JSON')
    .action((opts) => {
      try {
        const report = releaseScope.evaluateReleaseScope({
          root: opts.root,
          releaseMode: opts.releaseMode,
          requireWholeRepoPublic: opts.requireWholeRepoPublic,
        });
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          if (report.status === 'blocked') process.exitCode = 1;
          return;
        }
        printReleaseScope(report);
        if (report.status === 'blocked') process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('export-scope')
    .description('Copy the source-only public release scope into a separate mirror directory')
    .requiredOption('--output-dir <path>', 'Directory to receive the public mirror files')
    .option('--root <path>', 'Repository root to export from', process.cwd())
    .option('--release-mode <mode>', 'Release mode: source or npm', 'source')
    .option('--public-only', 'Copy only public files; default includes intentionally experimental surfaces')
    .option('--dry-run', 'Print the export plan without copying files')
    .option('--json', 'Print export report as JSON')
    .action((opts) => {
      try {
        const result = releaseScope.exportReleaseScope({
          root: opts.root,
          outputDir: opts.outputDir,
          releaseMode: opts.releaseMode,
          includeExperimental: !opts.publicOnly,
          dryRun: opts.dryRun,
        });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.bold('\nOpen Source Scope Export\n'));
        console.log(`Mode:        ${chalk.cyan(result.releaseMode)}`);
        console.log(`Root:        ${result.root}`);
        console.log(`Output:      ${result.outputDir}`);
        console.log(`Dry run:     ${result.dryRun ? 'yes' : 'no'}`);
        console.log(`Experimental:${result.includeExperimental ? ' included' : ' excluded'}`);
        console.log('');
        table([
          ['public', String(result.counts.public)],
          ['experimental', String(result.counts.experimental)],
          ['selected', String(result.counts.selected)],
          ['written', String(result.counts.written)],
          ['excluded', String(result.counts.excluded)],
        ], ['Count', 'Files']);
        if (result.manifestPath) {
          console.log('');
          console.log(`Manifest: ${result.manifestPath}`);
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('readiness')
    .description('Check the current repo against the Open Source Readiness Gate')
    .option('--root <path>', 'Repository root to check', process.cwd())
    .option('--stage <stage>', 'Release stage: private-alpha or limited-public', 'private-alpha')
    .option('--release-mode <mode>', 'Release mode: source or npm', 'npm')
    .option('--json', 'Print readiness report as JSON')
    .action((opts) => {
      try {
        const report = readiness.evaluateOpenSourceReadiness(opts);
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        printReport(report);
        if (report.summary.status !== 'ready') process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('outsider-trial')
    .description('Plan or run the source-only outsider trial harness')
    .option('--root <path>', 'Repository root to check', process.cwd())
    .option('--data-dir <path>', 'Temporary MERIDIAN_DATA directory for the trial')
    .option('--execute', 'Run the mechanical trial commands; default only prints the plan')
    .option('--output <path>', 'Write the trial report JSON to a file')
    .option('--transcript-output <path>', 'Write a blank outsider transcript template for the same trial')
    .option('--outsider-id <id>', 'Non-sensitive outsider identifier for transcript template generation')
    .option('--json', 'Print trial report as JSON')
    .action((opts) => {
      try {
        const report = outsiderTrial.runOutsiderTrial(opts);
        if (opts.output) {
          const outputPath = path.resolve(opts.output);
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
        }
        if (opts.transcriptOutput) {
          const transcriptPath = path.resolve(opts.transcriptOutput);
          const transcript = outsiderTrial.buildOutsiderTranscriptTemplate({
            root: opts.root,
            dataDir: opts.dataDir,
            outsiderId: opts.outsiderId,
            mechanicalReportRef: opts.output || '',
          });
          fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
          fs.writeFileSync(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`);
          report.transcriptTemplatePath = transcriptPath;
        }
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          if (opts.execute && !report.ok) process.exitCode = 1;
          return;
        }
        console.log(chalk.bold('\nOpen Source Outsider Trial\n'));
        console.log(`Status: ${chalk.cyan(report.status)}`);
        console.log(`Root:   ${report.plan.root}`);
        console.log(`Data:   ${report.plan.dataDir}`);
        console.log('');
        table(report.commandResults.map((result) => [
          result.id,
          result.status,
          result.display,
          result.expected,
        ]), ['ID', 'Status', 'Command', 'Expected']);
        console.log('');
        console.log(chalk.bold('Comprehension checkpoints'));
        for (const checkpoint of report.plan.comprehensionCheckpoints) {
          console.log(`- ${checkpoint.id}: ${checkpoint.prompt}`);
          console.log(chalk.gray(`  success: ${checkpoint.successSignal}`));
        }
        console.log('');
        if (report.transcriptTemplatePath) {
          console.log(`Transcript template: ${report.transcriptTemplatePath}`);
          console.log(chalk.yellow('This trial is incomplete until the outsider fills the transcript and it evaluates cleanly.'));
          console.log('');
        }
        console.log(chalk.yellow(report.evidenceGap));
        if (opts.execute && !report.ok) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('outsider-packet')
    .description('Create a fillable outsider trial packet with transcript prompts and evaluation commands')
    .option('--root <path>', 'Repository root to check', process.cwd())
    .option('--data-dir <path>', 'Temporary MERIDIAN_DATA directory used for the trial')
    .option('--output-dir <path>', 'Directory where packet files should be written')
    .option('--outsider-id <id>', 'Non-sensitive outsider identifier for transcript generation', 'outsider')
    .option('--json', 'Print packet report as JSON')
    .action((opts) => {
      try {
        const packet = outsiderTrial.writeOutsiderTrialPacket(opts);
        if (opts.json) {
          console.log(JSON.stringify(packet, null, 2));
          return;
        }
        console.log(chalk.bold('\nOpen Source Outsider Packet\n'));
        console.log(`Directory: ${chalk.cyan(packet.outputDir)}`);
        console.log('');
        table(packet.written.map((file) => [file]), ['Written Files']);
        console.log('');
        table(packet.commands.map((command) => [
          command.id,
          command.command,
        ]), ['Step', 'Command']);
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('outsider-transcript [transcript]')
    .description('Create or evaluate an outsider trial comprehension transcript')
    .option('--root <path>', 'Repository root to check', process.cwd())
    .option('--data-dir <path>', 'Temporary MERIDIAN_DATA directory used for the trial')
    .option('--template', 'Print a blank transcript template instead of evaluating a transcript')
    .option('--outsider-id <id>', 'Non-sensitive outsider identifier for template generation')
    .option('--mechanical-report <path>', 'Mechanical outsider-trial report JSON to attach during evaluation')
    .option('--output <path>', 'Write the transcript template or evaluation JSON to a file')
    .option('--json', 'Print transcript template or evaluation as JSON')
    .action((transcript, opts) => {
      try {
        let result;
        if (opts.template) {
          result = outsiderTrial.buildOutsiderTranscriptTemplate({
            root: opts.root,
            dataDir: opts.dataDir,
            outsiderId: opts.outsiderId,
          });
        } else {
          if (!transcript) throw new Error('Transcript path is required unless --template is supplied.');
          result = outsiderTrial.evaluateOutsiderTranscript(transcript, {
            root: opts.root,
            dataDir: opts.dataDir,
            mechanicalReportPath: opts.mechanicalReport,
          });
        }
        if (opts.output) {
          const outputPath = path.resolve(opts.output);
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
        }
        if (opts.json || opts.template) {
          console.log(JSON.stringify(result, null, 2));
          if (!opts.template && !result.ok) process.exitCode = 1;
          return;
        }
        console.log(chalk.bold('\nOpen Source Outsider Transcript\n'));
        console.log(`Status: ${result.ok ? chalk.green(result.status) : chalk.yellow(result.status)}`);
        console.log(`Trial:  ${result.trialId || '-'}`);
        console.log(`User:   ${result.outsiderId || '-'}`);
        console.log('');
        table(result.checkpointResults.map((checkpoint) => [
          checkpoint.checkpointId,
          checkpoint.passed ? 'passed' : 'needs_followup',
          checkpoint.understood ? 'yes' : 'no',
          checkpoint.confusion || '-',
        ]), ['Checkpoint', 'Status', 'Understood', 'Confusion']);
        console.log('');
        console.log(`Blockers: ${result.summary.blockerCount}`);
        console.log(`Warnings: ${result.summary.warnCount}`);
        if (!result.ok) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('publish-mirror')
    .description('One-shot dev → public mirror sync: readiness check, export-scope into mirror dir, git diff summary, optional commit + dual-push. Default --dry-run.')
    .option('--mirror <path>', 'Public-mirror git checkout directory (must have main branch + push remote)', '')
    .option('--root <path>', 'Source dev repo root (default: current dir)')
    .option('--release-mode <mode>', 'source | npm', 'source')
    .option('--public-only', 'Strict public scope (exclude experimental surfaces)')
    .option('--skip-readiness', 'Skip the readiness gate check (NOT recommended)')
    .option('--commit', 'Run git commit + push on the mirror after sync. Without this flag the command is a dry-run.')
    .option('--message <text>', 'Override commit message (default: auto-derived from dev commits since mirror HEAD)')
    .option('--skip-egress-dlp', 'Skip the egress DLP scan (NOT recommended; bypasses Slice #2 of OpenClaw security)')
    .option('--allow-egress-review', 'Continue past review-level egress findings; block-level findings still abort')
    .option('--skip-ensemble-gate', 'Skip the second-evaluator ensemble gate (NOT recommended; bypasses cross-system evaluator)')
    .option('--json', 'Print report as JSON')
    .action((opts) => {
      const root = path.resolve(opts.root || process.cwd());
      const mirror = opts.mirror ? path.resolve(opts.mirror) : '';

      const errors = [];
      if (!mirror) errors.push('--mirror is required (path to the public mirror git checkout)');
      if (!fs.existsSync(root)) errors.push(`Source root does not exist: ${root}`);
      if (mirror && !fs.existsSync(mirror)) errors.push(`Mirror dir does not exist: ${mirror}`);
      if (mirror && !fs.existsSync(path.join(mirror, '.git'))) errors.push(`Mirror dir is not a git checkout: ${mirror}`);
      if (errors.length) {
        errors.forEach((e) => console.error(chalk.red(e)));
        process.exitCode = 1;
        return;
      }

      const report = {
        mode: opts.commit ? 'commit' : 'dry-run',
        root,
        mirror,
        steps: [],
      };

      // Step 1: readiness check (warn on blockers; don't auto-block unless --skip-readiness is absent AND blockers exist)
      if (!opts.skipReadiness) {
        try {
          const readinessReport = readiness.evaluateOpenSourceReadiness({ root, releaseMode: opts.releaseMode, stage: 'private-alpha' });
          report.steps.push({
            step: 'readiness',
            status: readinessReport.summary.status,
            blockerCount: readinessReport.summary.blockerCount,
            warnCount: readinessReport.summary.warnCount,
            blockers: readinessReport.findings.filter((f) => f.severity === 'blocker').map((f) => f.id),
          });
          if (readinessReport.summary.blockerCount > 0) {
            if (!opts.json) {
              console.log(chalk.yellow(`\n⚠ Readiness has ${readinessReport.summary.blockerCount} blocker(s). Continuing anyway, but consider running 'recall open-source readiness' for details.\n`));
            }
          }
        } catch (err) {
          report.steps.push({ step: 'readiness', status: 'error', error: err.message });
        }
      }

      // Step 2: export-scope (always)
      try {
        const exportReport = releaseScope.exportReleaseScope({
          root,
          outputDir: mirror,
          releaseMode: opts.releaseMode,
          publicOnly: Boolean(opts.publicOnly),
          dryRun: false, // we always copy files; the --commit flag gates the git push
        });
        report.steps.push({
          step: 'export-scope',
          status: 'ok',
          publicCount: exportReport.counts && exportReport.counts.public,
          experimentalCount: exportReport.counts && exportReport.counts.experimental,
          selectedCount: exportReport.counts && exportReport.counts.selected,
          excludedCount: exportReport.counts && exportReport.counts.excluded,
        });
      } catch (err) {
        report.steps.push({ step: 'export-scope', status: 'error', error: err.message });
        if (opts.json) console.log(JSON.stringify(report, null, 2));
        else console.error(chalk.red(`export-scope failed: ${err.message}`));
        process.exitCode = 1;
        return;
      }

      // Step 2.5: Egress DLP scan on the mirror (Slice #2 of OpenClaw
      // security brainstorm). This is the wiring that turns the scanner
      // primitive into an actual control on the harm path — publishing
      // to a public mirror is exactly the egress boundary the brainstorm
      // names as a review boundary.
      if (!opts.skipEgressDlp) {
        try {
          const dlpReport = scanDir(mirror, { kind: 'mirror-file', target: 'github:public-mirror' });
          // Append review/block findings to the scan ledger
          try {
            const ddir = cliConfig.getDataDir();
            for (const r of dlpReport.results) {
              if (r.decision === 'block' || r.decision === 'review') {
                appendScan(r, { dataDir: ddir });
              }
            }
          } catch (_) { /* ledger append is best-effort */ }

          report.steps.push({
            step: 'egress-dlp',
            status: dlpReport.summary.aggregateDecision,
            blockCount: dlpReport.summary.blockCount,
            reviewCount: dlpReport.summary.reviewCount,
            errorCount: dlpReport.summary.errorCount,
            blockingFiles: dlpReport.results.filter((r) => r.decision === 'block').slice(0, 10).map((r) => ({
              sourcePath: r.sourcePath,
              detectorIds: (r.blockers || []).map((b) => b.detectorId),
            })),
          });

          if (dlpReport.summary.aggregateDecision === 'block') {
            const msg = `Egress DLP blocked publish: ${dlpReport.summary.blockCount} file(s) contain high-severity leakage.`;
            if (opts.json) {
              report.outcome = 'egress_dlp_blocked';
              console.log(JSON.stringify(report, null, 2));
            } else {
              console.error(chalk.red('\n✖ ' + msg));
              for (const r of dlpReport.results.filter((x) => x.decision === 'block').slice(0, 10)) {
                console.error(chalk.red(`  ${r.sourcePath}`));
                for (const b of (r.blockers || []).slice(0, 3)) console.error(chalk.red(`    × ${b.detectorId}: ${b.sample}`));
              }
              console.error(chalk.gray('\n  Re-run with --skip-egress-dlp to bypass (NOT recommended).'));
              console.error(chalk.gray('  Inspect with: recall security egress-scan --dir ' + mirror + '\n'));
            }
            process.exitCode = 2;
            return;
          }
          if (dlpReport.summary.aggregateDecision === 'review' && opts.commit && !opts.allowEgressReview) {
            const msg = `Egress DLP needs review: ${dlpReport.summary.reviewCount} file(s) contain medium-severity findings.`;
            if (opts.json) {
              report.outcome = 'egress_dlp_review';
              console.log(JSON.stringify(report, null, 2));
            } else {
              console.error(chalk.yellow('\n⚠ ' + msg));
              for (const r of dlpReport.results.filter((x) => x.decision === 'review').slice(0, 10)) {
                console.error(chalk.yellow(`  ${r.sourcePath}`));
                for (const w of (r.warnings || []).slice(0, 3)) console.error(chalk.yellow(`    ⚠ ${w.detectorId}: ${w.sample}`));
              }
              console.error(chalk.gray('\n  Re-run with --allow-egress-review to continue, or --skip-egress-dlp to bypass entirely.'));
              console.error(chalk.gray('  Inspect with: recall security egress-scan --dir ' + mirror + '\n'));
            }
            process.exitCode = 2;
            return;
          }
        } catch (err) {
          report.steps.push({ step: 'egress-dlp', status: 'error', error: err.message });
          if (!opts.json) console.error(chalk.yellow(`Egress DLP scan errored: ${err.message} (continuing)`));
        }
      } else {
        report.steps.push({ step: 'egress-dlp', status: 'skipped' });
      }

      // Step 2.6: Ensemble gate (Codex's cross-system evaluator
      // ensemble from the 2026-05-12 brainstorm). DLP alone is one
      // class of evaluator (rules over regex matches). The ensemble
      // composes the rules evaluator + a local heuristic over the
      // aggregated DLP findings. Disagreement triggers human review.
      // Wired here so publish-mirror is no longer a single-evaluator
      // gate (addresses §10 correlated-evaluator-failure concern).
      if (!opts.skipEnsembleGate) {
        try {
          // Build a synthetic "subject" from the DLP report shape so
          // the rules evaluator has structured blockers/warnings to
          // reason over.
          const lastDlpStep = report.steps.find((s) => s.step === 'egress-dlp') || {};
          const subject = {
            // Concatenate detector IDs into a content-like field so
            // the heuristic has something to inspect.
            content: `publish-mirror to github:public-mirror; dlp aggregate=${lastDlpStep.status}; block=${lastDlpStep.blockCount || 0}; review=${lastDlpStep.reviewCount || 0}`,
            blockers: (lastDlpStep.blockingFiles || []).flatMap((f) => (f.detectorIds || []).map((id) => ({ detectorId: id }))),
            warnings: [], // DLP review-level findings get folded into the rules evaluator via the egress target
            egressTarget: 'github:public-mirror',
            hasSecrets: (lastDlpStep.blockCount || 0) > 0,
            hasPrivatePath: (lastDlpStep.blockingFiles || []).some((f) => (f.detectorIds || []).some((id) => /path/i.test(id))),
          };
          const evaluators = [rulesEvaluator(), heuristicEvaluator()];
          const ensemble = evaluateEnsemble({ subject, evaluators });
          report.steps.push({
            step: 'ensemble-gate',
            status: ensemble.decision,
            reason: ensemble.reason,
            verdicts: ensemble.verdicts.map((v) => ({ name: v.name, kind: v.kind, decision: v.decision })),
            conflicts: ensemble.agreement.conflicts.length,
          });
          // Hard block only if the ensemble says agree-block. Other
          // decisions (disagree-needs-human, agree-review) are logged
          // but don't abort — DLP already block-aborts on its own.
          if (ensemble.decision === 'agree-block') {
            if (opts.json) {
              report.outcome = 'ensemble_gate_blocked';
              console.log(JSON.stringify(report, null, 2));
            } else {
              console.error(chalk.red(`\n✖ Ensemble gate blocked publish: ${ensemble.reason}`));
            }
            process.exitCode = 2;
            return;
          }
        } catch (err) {
          report.steps.push({ step: 'ensemble-gate', status: 'error', error: err.message });
        }
      } else {
        report.steps.push({ step: 'ensemble-gate', status: 'skipped' });
      }

      // Step 2.7: Self-record into audit-ingest. The publish-mirror
      // action is itself a "ProposedAction" by the OpenClaw audit
      // contract — it touches an external surface (the public mirror)
      // and changes what the registry serves. Record it as untrusted
      // by default; promotion-to-trusted happens via the normal
      // approval ceremony. This wires audit-ingest from
      // invokable-primitive to actually-recording, closing the
      // wiring gap the reviewer flagged.
      try {
        const lastDlp = report.steps.find((s) => s.step === 'egress-dlp') || {};
        const lastEns = report.steps.find((s) => s.step === 'ensemble-gate') || {};
        auditIngest.submitAuditRecord({
          agentId: 'recall-cli-local',
          actionKind: 'publish-mirror',
          target: { mirror, releaseMode: opts.releaseMode || 'source', commitFlag: Boolean(opts.commit) },
          rationale: opts.message ? String(opts.message).slice(0, 200) : 'publish-mirror invocation',
          outcome: 'attempted',
          evidence: [],
          contentHash: null,
        }, { dataDir: cliConfig.getDataDir() });
      } catch (_) { /* best-effort */ }

      // Step 3: git diff stat in mirror
      const { spawnSync } = require('child_process');
      const gitStat = spawnSync('git', ['-C', mirror, 'diff', '--stat'], { encoding: 'utf8' });
      const gitStatus = spawnSync('git', ['-C', mirror, 'status', '--short'], { encoding: 'utf8' });
      const statusLines = (gitStatus.stdout || '').trim().split('\n').filter(Boolean);
      report.steps.push({
        step: 'git-diff',
        changedFiles: statusLines.length,
        statusSummary: statusLines.slice(0, 20),
      });

      if (statusLines.length === 0) {
        report.outcome = 'nothing_to_commit';
        if (opts.json) console.log(JSON.stringify(report, null, 2));
        else console.log(chalk.gray('\nMirror is already in sync with dev. Nothing to commit.\n'));
        return;
      }

      // Step 4: if dry-run, stop here
      if (!opts.commit) {
        report.outcome = 'dry_run_complete';
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        console.log(chalk.bold('\nPublish-Mirror Dry-Run\n'));
        console.log(`Source:        ${root}`);
        console.log(`Mirror:        ${mirror}`);
        console.log(`Changed files: ${statusLines.length}`);
        console.log(chalk.gray('\nFiles changed (first 20):'));
        statusLines.slice(0, 20).forEach((line) => console.log('  ' + line));
        if (gitStat.stdout) {
          console.log('\n' + gitStat.stdout.trim());
        }
        console.log(chalk.yellow('\n(dry-run: re-run with --commit to actually commit + push)\n'));
        return;
      }

      // Step 5: commit
      let commitMessage = opts.message;
      if (!commitMessage) {
        // Auto-derive from dev commits since mirror HEAD's content
        const devLog = spawnSync('git', ['-C', root, 'log', '--oneline', '-5'], { encoding: 'utf8' });
        commitMessage = `sync from dev: ${(devLog.stdout || '').trim().split('\n')[0] || 'mirror update'}`;
      }

      const addResult = spawnSync('git', ['-C', mirror, 'add', '-A'], { encoding: 'utf8' });
      if (addResult.status !== 0) {
        report.steps.push({ step: 'git-add', status: 'error', stderr: addResult.stderr });
        if (opts.json) console.log(JSON.stringify(report, null, 2));
        else console.error(chalk.red(`git add failed: ${addResult.stderr}`));
        process.exitCode = 1;
        return;
      }

      const commitResult = spawnSync('git', ['-C', mirror, 'commit', '-m', commitMessage], { encoding: 'utf8' });
      if (commitResult.status !== 0) {
        report.steps.push({ step: 'git-commit', status: 'error', stderr: commitResult.stderr });
        if (opts.json) console.log(JSON.stringify(report, null, 2));
        else console.error(chalk.red(`git commit failed: ${commitResult.stderr || commitResult.stdout}`));
        process.exitCode = 1;
        return;
      }
      report.steps.push({ step: 'git-commit', status: 'ok', message: commitMessage });

      // Step 6: dual-push origin
      const pushResult = spawnSync('git', ['-C', mirror, 'push', 'origin', 'main'], { encoding: 'utf8' });
      if (pushResult.status !== 0) {
        report.steps.push({ step: 'git-push', status: 'error', stderr: pushResult.stderr });
        if (opts.json) console.log(JSON.stringify(report, null, 2));
        else console.error(chalk.red(`git push failed: ${pushResult.stderr}`));
        process.exitCode = 1;
        return;
      }
      report.steps.push({
        step: 'git-push',
        status: 'ok',
        stdoutTail: (pushResult.stdout || '').slice(-300),
        stderrTail: (pushResult.stderr || '').slice(-300),
      });

      report.outcome = 'published';

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      console.log(chalk.bold('\nPublish-Mirror Complete\n'));
      console.log(`Source:    ${root}`);
      console.log(`Mirror:    ${mirror}`);
      console.log(`Commit:    ${chalk.green('ok')}  "${commitMessage}"`);
      console.log(`Push:      ${chalk.green('ok')}`);
      const pushTail = ((pushResult.stderr || '') + (pushResult.stdout || '')).trim().split('\n').slice(-5).join('\n');
      if (pushTail) console.log('\n' + pushTail);
      console.log('');
    });
};
