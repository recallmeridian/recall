'use strict';

const chalk = require('chalk');
const meridian = require('../meridian-core');
const cliConfig = require('../cli-config');
const research = require('../research');
const { table } = require('../format');

function getKb() {
  return meridian.init(cliConfig.getDataDir());
}

function projectOption(cmd) {
  return cmd.option('-p, --project <project>', 'Research project', research.DEFAULT_PROJECT);
}

module.exports = function(program) {
  const cmd = program
    .command('research')
    .description('Manage research problems, verifier traces, and promotion records');

  projectOption(
    cmd
      .command('init')
      .description('Create the research project if it does not exist')
  ).action((opts) => {
    const kb = getKb();
    try {
      const project = research.ensureProject(kb, opts.project);
      console.log(chalk.green(`Research project ready: ${project.id}`));
      if (project.description) console.log(chalk.gray(project.description));
    } catch (err) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exitCode = 1;
    } finally {
      kb.close();
    }
  });

  projectOption(
    cmd
      .command('problem <id>')
      .description('Add a research problem as a candidate entry')
      .requiredOption('-t, --title <title>', 'Problem title')
      .requiredOption('-s, --statement <statement>', 'Informal problem statement')
      .option('--formal <statement>', 'Formal Lean statement')
      .option('--source-url <url>', 'Canonical source URL')
      .option('--source-ref <ref>', 'Source reference ID')
      .option('--domain <domain>', 'Domain', 'math')
      .option('--tags <tags>', 'Comma-separated tags')
  ).action((id, opts) => {
    const kb = getKb();
    try {
      const entry = research.addProblem(kb, opts.project, {
        id,
        title: opts.title,
        statement: opts.statement,
        formalStatement: opts.formal || '',
        sourceUrl: opts.sourceUrl || '',
        sourceRef: opts.sourceRef || '',
        domain: opts.domain,
        tags: opts.tags ? opts.tags.split(',').map((tag) => tag.trim()).filter(Boolean) : [],
      });
      console.log(chalk.green('Problem added.'));
      console.log(`  Project: ${opts.project}`);
      console.log(`  ID:      ${chalk.cyan(entry.id)}`);
      console.log(`  Status:  ${entry.status}`);
    } catch (err) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exitCode = 1;
    } finally {
      kb.close();
    }
  });

  projectOption(
    cmd
      .command('trace <problem-id> <trace-path>')
      .description('Ingest an immutable JSONL verifier trace as a research attempt')
      .option('--id <id>', 'Attempt entry ID')
      .option('--title <title>', 'Attempt title')
      .option('--status <status>', 'partial|failed|verified|drift_suspected', 'partial')
      .option('--adapter <adapter>', 'Verifier adapter name', 'external')
      .option('--verifier <verifier>', 'Verifier name', 'unknown')
      .option('--verifier-version <version>', 'Verifier version')
      .option('--artifact <path>', 'Verified artifact/proof path')
      .option('--failure <reason>', 'Failure reason')
      .option('--drift <status>', 'unchecked|clear|drift_suspected', 'unchecked')
      .option('--notes <notes>', 'Operator notes')
  ).action((problemId, tracePath, opts) => {
    const kb = getKb();
    try {
      const entry = research.ingestTrace(kb, opts.project, {
        id: opts.id,
        problemId,
        tracePath,
        title: opts.title,
        status: opts.status,
        adapter: opts.adapter,
        verifier: opts.verifier,
        verifierVersion: opts.verifierVersion || '',
        artifactPath: opts.artifact || '',
        failureReason: opts.failure || '',
        driftStatus: opts.drift,
        notes: opts.notes || '',
      });
      const trace = entry._extensions.trace;
      console.log(chalk.green('Trace ingested.'));
      console.log(`  Attempt: ${chalk.cyan(entry.id)}`);
      console.log(`  Status:  ${entry._extensions.attemptStatus}`);
      console.log(`  Lines:   ${trace.lineCount} (${trace.parsedCount} parsed)`);
      console.log(`  SHA256:  ${trace.hash}`);
    } catch (err) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exitCode = 1;
    } finally {
      kb.close();
    }
  });

  projectOption(
    cmd
      .command('status')
      .description('Show research problem and attempt status')
  ).action((opts) => {
    const kb = getKb();
    try {
      const status = research.getResearchStatus(kb, opts.project);
      console.log(chalk.bold(`\nResearch status: ${opts.project}\n`));
      table([
        ['Problems', String(status.counts.problems)],
        ['Attempts', String(status.counts.attempts)],
        ['Verified', String(status.counts.verified)],
        ['Partial', String(status.counts.partial)],
        ['Failed', String(status.counts.failed)],
        ['Drift suspected', String(status.counts.driftSuspected)],
      ], ['Metric', 'Count']);
      console.log('');
    } catch (err) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exitCode = 1;
    } finally {
      kb.close();
    }
  });

  projectOption(
    cmd
      .command('list')
      .description('List research entries')
      .option('--type <type>', 'problem|attempt')
  ).action((opts) => {
    const kb = getKb();
    try {
      const { entries } = research.getResearchStatus(kb, opts.project);
      const filtered = opts.type
        ? entries.filter((entry) => entry._extensions.researchType === opts.type)
        : entries;

      if (filtered.length === 0) {
        console.log(chalk.gray('No research entries found.'));
        return;
      }

      table(filtered.map((entry) => [
        entry.id,
        entry._extensions.researchType,
        entry._extensions.lifecycle || '',
        entry._extensions.attemptStatus || '',
        entry.name,
      ]), ['ID', 'Type', 'Lifecycle', 'Attempt', 'Name']);
      console.log('');
    } catch (err) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exitCode = 1;
    } finally {
      kb.close();
    }
  });

  projectOption(
    cmd
      .command('workflow <problem-id>')
      .description('Show the eight-step research workflow for a problem')
  ).action((problemId, opts) => {
    const kb = getKb();
    try {
      const workflow = research.getWorkflow(kb, opts.project, problemId);
      table(workflow.map((step, index) => [
        String(index + 1),
        step.id,
        step.status,
        step.completedAt || '',
        step.title,
      ]), ['#', 'Step', 'Status', 'Completed', 'Title']);
      console.log('');
    } catch (err) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exitCode = 1;
    } finally {
      kb.close();
    }
  });

  projectOption(
    cmd
      .command('next <problem-id>')
      .description('Check off the current workflow step and move to the next one')
      .option('--step <step-id>', 'Specific step to complete instead of current in-progress step')
      .option('--notes <notes>', 'Completion notes')
  ).action((problemId, opts) => {
    const kb = getKb();
    try {
      const result = research.completeWorkflowStep(kb, opts.project, problemId, opts.step || '', opts.notes || '');
      console.log(chalk.green(`Checked off: ${result.completed.title}`));
      if (result.next) {
        console.log(`Next: ${chalk.cyan(result.next.title)} (${result.next.id})`);
        console.log(chalk.gray(result.next.description));
      } else {
        console.log(chalk.green('Workflow complete.'));
      }
    } catch (err) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exitCode = 1;
    } finally {
      kb.close();
    }
  });

  projectOption(
    cmd
      .command('step <problem-id> <step-id> <status>')
      .description('Manually set a workflow step status')
      .option('--notes <notes>', 'Step notes')
  ).action((problemId, stepId, status, opts) => {
    const kb = getKb();
    try {
      research.setWorkflowStep(kb, opts.project, problemId, stepId, status, opts.notes || '');
      console.log(chalk.green(`Step updated: ${stepId} -> ${status}`));
    } catch (err) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exitCode = 1;
    } finally {
      kb.close();
    }
  });

  projectOption(
    cmd
      .command('promote <attempt-id>')
      .description('Promote a verified attempt into validated research knowledge')
      .option('--notes <notes>', 'Promotion notes')
  ).action((attemptId, opts) => {
    const kb = getKb();
    try {
      const entry = research.promoteAttempt(kb, opts.project, attemptId, opts.notes || '');
      console.log(chalk.green('Attempt promoted.'));
      console.log(`  ID:      ${chalk.cyan(entry.id)}`);
      console.log(`  Status:  ${entry.status}`);
      console.log(`  Verified at: ${entry.confidence.lastVerified}`);
    } catch (err) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exitCode = 1;
    } finally {
      kb.close();
    }
  });
};
