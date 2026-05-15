'use strict';

const path = require('path');
const chalk = require('chalk');
const { getDataDir } = require('../cli-config');
const { writeDashboard } = require('../dashboard');

module.exports = function(program) {
  const ui = program
    .command('ui')
    .description('Generate Recall visual UI artifacts')
    .action(() => {
      const result = writeDashboard({ outputPath: path.join(getDataDir(), 'dashboard.html') });
      console.log(chalk.bold('\nRecall Dashboard\n'));
      console.log(`  Wrote: ${chalk.cyan(result.outputPath)}`);
      console.log(`  Data:  ${chalk.cyan(result.model.dataDir)}`);
      console.log(`  Open the HTML file in a browser to inspect the local workspace.\n`);
    });

  ui
    .command('dashboard')
    .description('Generate a static Confluence-style Recall dashboard')
    .option('-o, --output <path>', 'Output HTML path')
    .option('--feature-project <project>', 'Feature ledger project id', 'recall-local')
    .action((opts) => {
      const result = writeDashboard({
        outputPath: opts.output || path.join(getDataDir(), 'dashboard.html'),
        featureProject: opts.featureProject,
      });
      console.log(chalk.bold('\nRecall Dashboard\n'));
      console.log(`  Wrote:          ${chalk.cyan(result.outputPath)}`);
      console.log(`  Data directory: ${chalk.cyan(result.model.dataDir)}`);
      console.log(`  Projects:       ${chalk.bold(result.model.kb.projects.length)}`);
      console.log(`  Features:       ${chalk.bold(result.model.features.count)}`);
      console.log(`  Imports:        ${chalk.bold(result.model.repo.counts.imports)}`);
      console.log('');
    });
};
