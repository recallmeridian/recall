'use strict';

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const cliConfig = require('../cli-config');
const {
  appendKnowledgeTransitionRecord,
  buildRollbackPlan,
  historyForArtifact,
  verifyKnowledgeTransitionLedger,
} = require('../knowledge-transition-ledger');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

function defaultKnowledgeDir(project = 'recall-local') {
  return path.join(cliConfig.getDataDir(), 'knowledge-transitions', project);
}

function defaultLedgerPath(project = 'recall-local') {
  return path.join(defaultKnowledgeDir(project), 'knowledge-transitions.jsonl');
}

module.exports = function(program) {
  const command = program
    .command('knowledge')
    .description('Manage local Recall knowledge lifecycle transition ledgers');

  command
    .command('transition <transition-json>')
    .description('Append an accepted knowledge promotion, demotion, or lifecycle transition')
    .option('--project <project>', 'Project id for default transition ledger path', 'recall-local')
    .option('--ledger-path <path>', 'Knowledge transition ledger JSONL path')
    .option('--actor <actor>', 'Actor recording the transition', 'knowledge-transition-ledger')
    .option('--now <iso>', 'Fixed timestamp for deterministic tests')
    .option('--human-approved', 'Mark this transition as human-approved')
    .option('--approver-id <id>', 'Human approver id')
    .option('--approval-ref <ref>', 'Approval evidence reference')
    .option('--json', 'Print appended transition record as JSON')
    .action((transitionJson, opts) => {
      try {
        const transition = readJson(transitionJson);
        const ledgerPath = opts.ledgerPath || defaultLedgerPath(opts.project);
        const record = appendKnowledgeTransitionRecord(ledgerPath, transition, {
          actor: opts.actor,
          now: opts.now,
          humanApproved: Boolean(opts.humanApproved),
          approverId: opts.approverId,
          approvalRef: opts.approvalRef,
        });
        const result = { ok: true, ledgerPath, record };
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.green(`Knowledge transition recorded: ${record.eventId}`));
        console.log(`Artifact: ${record.artifactId}`);
        console.log(`Ledger: ${ledgerPath}`);
      } catch (err) {
        if (opts.json && err.event) {
          console.log(JSON.stringify({ ok: false, event: err.event, error: err.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${err.message}`));
        }
        process.exitCode = 1;
      }
    });

  command
    .command('verify')
    .description('Verify the tamper-evident knowledge transition ledger')
    .option('--project <project>', 'Project id for default transition ledger path', 'recall-local')
    .option('--ledger-path <path>', 'Knowledge transition ledger JSONL path')
    .option('--json', 'Print verification as JSON')
    .action((opts) => {
      try {
        const ledgerPath = opts.ledgerPath || defaultLedgerPath(opts.project);
        const result = {
          ledgerPath,
          ...verifyKnowledgeTransitionLedger(ledgerPath),
        };
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          if (!result.ok) process.exitCode = 1;
          return;
        }
        const color = result.ok ? chalk.green : chalk.red;
        console.log(color(`Knowledge transition ledger: ${result.ok ? 'healthy' : 'tampered'}`));
        console.log(`Records: ${result.count}`);
        if (result.errors.length) console.log(chalk.red(`Errors: ${result.errors.join(', ')}`));
        if (!result.ok) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('history <artifact-id>')
    .description('List knowledge transition history for one artifact')
    .option('--project <project>', 'Project id for default transition ledger path', 'recall-local')
    .option('--ledger-path <path>', 'Knowledge transition ledger JSONL path')
    .option('--json', 'Print history as JSON')
    .action((artifactId, opts) => {
      try {
        const ledgerPath = opts.ledgerPath || defaultLedgerPath(opts.project);
        const records = historyForArtifact(ledgerPath, artifactId);
        const result = { ok: true, ledgerPath, artifactId, count: records.length, records };
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`Knowledge transition history for ${chalk.cyan(artifactId)}: ${records.length}`);
        records.forEach((record) => {
          console.log(`${record.sequence}. ${record.event.from} -> ${record.event.to} (${record.event.status})`);
        });
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('rollback-plan <artifact-id>')
    .description('Generate a non-destructive rollback/demotion plan for one artifact')
    .option('--project <project>', 'Project id for default transition ledger path', 'recall-local')
    .option('--ledger-path <path>', 'Knowledge transition ledger JSONL path')
    .option('--target-state <state>', 'Target lifecycle state')
    .option('--reason <reason...>', 'Rollback reason')
    .option('--falsifier <falsifier...>', 'Falsifier or contradiction evidence')
    .option('--evidence-ref <ref...>', 'Evidence reference')
    .option('--now <iso>', 'Fixed timestamp for deterministic tests')
    .option('--json', 'Print rollback plan as JSON')
    .action((artifactId, opts) => {
      try {
        const ledgerPath = opts.ledgerPath || defaultLedgerPath(opts.project);
        const result = {
          ledgerPath,
          ...buildRollbackPlan(ledgerPath, artifactId, {
            now: opts.now,
            targetState: opts.targetState,
            reasons: opts.reason,
            falsifiers: opts.falsifier,
            evidenceRefs: opts.evidenceRef,
          }),
        };
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`Rollback plan for ${chalk.cyan(artifactId)}: ${result.requiredAction}`);
        if (result.suggestedTransition) {
          console.log(`${result.suggestedTransition.from} -> ${result.suggestedTransition.to}`);
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });
};
