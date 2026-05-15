'use strict';

const chalk = require('chalk');
const meridian = require('../meridian-core');
const { getDataDir } = require('../cli-config');

module.exports = function(program) {
  program
    .command('verify <project> <entry-id>')
    .description('Mark a KB entry as verified (resets staleness clock)')
    .action((project, entryId) => {
      try {
        const kb = meridian.init(getDataDir());
        const entry = kb.verifyEntry(project, entryId);
        kb.close();

        const lastVerified = entry.confidence && entry.confidence.lastVerified
          ? entry.confidence.lastVerified
          : entry.updatedAt;

        console.log(chalk.green(`\nEntry "${entryId}" verified.`));
        console.log(`  Project:       ${project}`);
        console.log(`  Name:          ${entry.name || ''}`);
        console.log(`  Last verified: ${lastVerified}\n`);
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
};
