'use strict';

// recall openclaw — OpenClaw runtime stub CLI surface.
//
// Implements the producer side of the audit-ingest contract today,
// even before a full OpenClaw agent exists. Operators can manually
// invoke `openclaw propose-action` to run a candidate post / tool
// call / etc. through the security pipeline (DLP → gate → audit
// ledger) and see what would happen.
//
// This is the FIRST wired producer of the OpenClaw audit contract.
// Until now, audit-ingest had one producer (publish-mirror self-
// record). Now there's a real surface that takes ProposedActions.

const chalk = require('chalk');
const cliConfig = require('../cli-config');
const { processProposedAction } = require('../openclaw/runtime');

module.exports = function(program) {
  const command = program
    .command('openclaw')
    .description('OpenClaw runtime stub: propose actions through the security pipeline (DLP + gate + audit-ingest). Slice #1 receiver-side ships today; producer is this CLI.');

  command
    .command('propose-action')
    .description('Run a proposed action through the OpenClaw runtime gate. Returns allow / block / review + records to audit-ingest as untrusted. Does NOT execute the action (this is the stub).')
    .requiredOption('--kind <actionKind>', 'post | http_request | tool_call | read_kb | file_write | other')
    .requiredOption('--target <json>', 'Action target as JSON (e.g. \'{"channel":"moltbook","text":"hi"}\')')
    .option('--rationale <text>', 'Why the agent wants to do this')
    .option('--evidence <list>', 'Comma-separated KB entry ids cited as justification')
    .option('--agent-id <id>', 'Reporting agent id (default: openclaw-runtime-stub)')
    .option('--json', 'Print as JSON')
    .action(async (opts) => {
      try {
        let target;
        try { target = JSON.parse(opts.target); }
        catch (_) { throw new Error('--target must be valid JSON, got: ' + opts.target); }

        const result = await processProposedAction({
          action: {
            actionKind: opts.kind,
            target,
            rationale: opts.rationale || null,
            evidence: opts.evidence ? opts.evidence.split(',').map((s) => s.trim()).filter(Boolean) : [],
          },
          agentId: opts.agentId,
          dataDir: cliConfig.getDataDir(),
        });

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          if (result.decision === 'block') process.exitCode = 2;
          return;
        }

        const colour = result.decision === 'block' ? chalk.red
                     : result.decision === 'review' ? chalk.yellow
                     : chalk.green;
        console.log('');
        console.log(colour.bold(`OpenClaw Gate: ${result.decision.toUpperCase()}`));
        console.log(`Reason:         ${result.reason}`);
        console.log(`DLP decision:   ${result.dlpDecision}`);
        console.log(`Audit record:   ${result.recordId} (untrusted)`);
        if (result.blockers.length) {
          console.log('');
          console.log(chalk.red.bold(`Blockers (${result.blockers.length}):`));
          for (const b of result.blockers.slice(0, 5)) {
            console.log(`  × [${b.detectorId}] ${b.issue} → "${b.sample}"`);
          }
        }
        if (result.warnings.length) {
          console.log('');
          console.log(chalk.yellow.bold(`Warnings (${result.warnings.length}):`));
          for (const w of result.warnings.slice(0, 5)) {
            console.log(`  ⚠ [${w.detectorId}] ${w.concern} → "${w.sample}"`);
          }
        }
        console.log('');
        console.log(chalk.gray('To promote this audit record to trusted (out-of-band review):'));
        console.log(chalk.gray(`  recall security audit-promote --record-id ${result.recordId} --human-approval "<your-signature>"`));
        console.log('');

        if (result.decision === 'block') process.exitCode = 2;
      } catch (err) {
        console.error(chalk.red(`openclaw propose-action error: ${err.message}`));
        process.exitCode = 1;
      }
    });
};
