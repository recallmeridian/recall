'use strict';

const chalk = require('chalk');
const { buildIncomePipeline } = require('../income-pipeline');

function printPlan(plan) {
  console.log(chalk.bold('\nRecall Income Pipeline\n'));
  console.log(`Mode: ${plan.mode}`);
  console.log(`Goal: ${plan.goal}`);
  console.log(`Payment: ${plan.paymentRail}`);

  console.log(chalk.bold('\nBoundaries'));
  plan.prohibitedAutonomy.forEach((item) => console.log(`- ${item}`));

  console.log(chalk.bold('\nRecommended First Offer'));
  const first = plan.actionCards[0];
  console.log(`${first.title} (${first.risk} risk, score ${first.score})`);
  console.log(first.offer);
  console.log(`Range: $${first.estimatedPriceUsd.low}-$${first.estimatedPriceUsd.high}`);

  console.log(chalk.bold('\nPhases'));
  plan.phases.forEach((phase, index) => {
    console.log(`${index + 1}. ${phase.title}: ${phase.output}`);
  });

  console.log(chalk.bold('\nApproval Gates'));
  plan.nextHumanApprovals.forEach((item) => console.log(`- ${item}`));
  console.log('');
}

module.exports = function(program) {
  const command = program
    .command('income')
    .description('Plan ethical, human-approved revenue workflows using Recall as the operating base');

  command
    .command('plan')
    .description('Build a Recall income pipeline plan with action cards and approval gates')
    .option('--goal <text>', 'Revenue goal to optimize for')
    .option('--skills <items>', 'Comma- or semicolon-separated skill list')
    .option('--constraint <items>', 'Comma- or semicolon-separated extra constraints')
    .option('--payment-rail <text>', 'Payment rail to prepare wording for, without moving funds')
    .option('--user-name <name>', 'Name to use in proposal drafts')
    .option('--json', 'Print the full plan as JSON')
    .action((opts) => {
      const plan = buildIncomePipeline({
        goal: opts.goal,
        skills: opts.skills,
        constraints: opts.constraint,
        paymentRail: opts.paymentRail,
        userName: opts.userName,
      });
      if (opts.json) {
        console.log(JSON.stringify(plan, null, 2));
        return;
      }
      printPlan(plan);
    });
};

module.exports.printPlan = printPlan;
