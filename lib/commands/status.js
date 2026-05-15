'use strict';

const chalk = require('chalk');
const meridian = require('../meridian-core');
const { getDataDir } = require('../cli-config');

module.exports = function(program) {
  program
    .command('status')
    .description('Show KB stats: projects, entries, stale count, contradictions')
    .action(() => {
      try {
        const kb = meridian.init(getDataDir());
        const projects = kb.listProjects();
        const stats = kb.getStats();

        console.log(chalk.bold('\nMeridian Status\n'));
        console.log(`  Data directory: ${chalk.cyan(getDataDir())}`);
        console.log(`  Projects:       ${chalk.bold(projects.length)}`);
        console.log(`  Total entries:  ${chalk.bold(stats.nodeCount)}`);
        console.log(`  Relationships:  ${chalk.bold(stats.edgeCount)}`);
        console.log(`  Contradictions: ${stats.contradictionCount > 0 ? chalk.red(stats.contradictionCount) : chalk.green(0)}`);

        if (projects.length > 0) {
          console.log(chalk.bold('\n  Projects:'));
          for (const p of projects) {
            console.log(`    ${chalk.cyan(p.id)} â€” ${p.description || p.name || ''}`);
          }
        }

        console.log('');
        kb.close();
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        console.error(chalk.gray('Run "meridian init" to create a data directory.'));
      }
    });
};
