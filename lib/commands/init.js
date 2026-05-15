'use strict';

const chalk = require('chalk');
const meridian = require('../meridian-core');
const { getDataDir } = require('../cli-config');
const { prompt } = require('../prompt');
const historyImport = require('../history-import');

module.exports = function(program) {
  program
    .command('init')
    .description('Initialize a new Meridian project')
    .option('--import-history', 'Scan known AI/coding history sources after project setup')
    .action(async (opts) => {
      try {
        const kb = meridian.init(getDataDir());

        console.log(chalk.bold('\nCreate a new Meridian project\n'));

        const id = await prompt('Project ID (kebab-case, e.g. my-project): ');
        if (!id) { console.error(chalk.red('Project ID is required.')); process.exit(1); }

        const name = await prompt('Project name: ');
        if (!name) { console.error(chalk.red('Project name is required.')); process.exit(1); }

        const description = await prompt('Description (optional): ');

        const project = kb.createProject({ id, name, description });
        kb.close();

        console.log(chalk.green(`\nProject "${project.id}" created successfully.`));
        console.log(`  Name:        ${project.name}`);
        if (project.description) console.log(`  Description: ${project.description}`);
        console.log(`  Created at:  ${project.createdAt}\n`);

        if (opts.importHistory) {
          const sources = historyImport.scanSources();
          console.log(chalk.bold('History import scan\n'));
          if (sources.length === 0) {
            console.log(chalk.gray('No known AI/coding history sources found automatically.'));
            console.log(chalk.gray('Run `recall import-history scan --root <path>` or import explicit exports later.\n'));
          } else {
            for (const source of sources) {
              console.log(`  ${chalk.cyan(source.source.padEnd(12))} ${source.kind.padEnd(9)} ${source.path}`);
            }
            console.log(chalk.gray('\nRun `recall import-history import --source <source> --path <path>` for any source you approve.\n'));
          }
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
};
