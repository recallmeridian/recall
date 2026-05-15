'use strict';

const chalk = require('chalk');
const meridian = require('../meridian-core');
const { getDataDir } = require('../cli-config');
const { prompt, choose } = require('../prompt');

const CATEGORIES = [
  'mechanism',
  'experimental-finding',
  'hypothesis',
  'failed-approach',
  'drug-target',
  'biomarker',
  'clinical-observation',
  'method',
];

module.exports = function(program) {
  program
    .command('add <project>')
    .description('Add a new knowledge entry to a project')
    .action(async (project) => {
      try {
        const kb = meridian.init(getDataDir());

        console.log(chalk.bold(`\nAdd entry to project "${project}"\n`));

        const name = await prompt('Name: ');
        if (!name) { console.error(chalk.red('Name is required.')); kb.close(); process.exit(1); }

        const category = await choose('\nCategory:', CATEGORIES);

        const description = await prompt('\nDescription: ');
        if (!description) { console.error(chalk.red('Description is required.')); kb.close(); process.exit(1); }

        const diseaseArea = await prompt('Disease area (optional): ');

        const genesRaw = await prompt('Genes (comma-separated, optional): ');
        const genes = genesRaw ? genesRaw.split(',').map(g => g.trim()).filter(Boolean) : [];

        const negativeRaw = await prompt('Is negative result? (y/n) [n]: ');
        const isNegativeResult = negativeRaw.toLowerCase() === 'y';

        const entryData = {
          name,
          category,
          description,
          status: 'active',
          ...(diseaseArea && { disease_area: diseaseArea }),
          ...(genes.length > 0 && { genes }),
          ...(isNegativeResult && { isNegativeResult: true }),
        };

        const entry = kb.addEntry(project, entryData);
        kb.close();

        console.log(chalk.green(`\nEntry added successfully.`));
        console.log(`  ID:       ${chalk.cyan(entry.id)}`);
        console.log(`  Name:     ${entry.name}`);
        console.log(`  Category: ${entry.category}`);
        console.log(`  Added at: ${entry.addedAt}\n`);
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
};
