'use strict';

const chalk = require('chalk');
const meridian = require('../meridian-core');
const cliConfig = require('../cli-config');
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
    .command('ingest <identifier>')
    .description('Fetch and ingest a paper (DOI/PMID/arXiv) into a project')
    .option('-p, --project <project>', 'Target project')
    .action(async (identifier, opts) => {
      try {
        const kb = meridian.init(cliConfig.getDataDir());

        // Resolve project
        let project = opts.project || cliConfig.get('defaultProject');
        if (!project) {
          const projects = kb.listProjects();
          if (projects.length === 0) {
            console.error(chalk.red('No projects found. Run "meridian init" first.'));
            kb.close();
            process.exit(1);
          }
          const names = projects.map(p => p.id);
          project = await choose('\nSelect project:', names);
        }

        console.log(chalk.bold(`\nFetching: ${identifier}\n`));

        let paper;
        try {
          paper = await meridian.fetch(identifier);
        } catch (err) {
          console.error(chalk.red(`Failed to fetch paper: ${err.message}`));
          kb.close();
          process.exit(1);
        }

        // Display paper metadata
        console.log(chalk.bold('Title:    ') + paper.title);
        if (paper.authors && paper.authors.length > 0) {
          console.log(chalk.bold('Authors:  ') + paper.authors.slice(0, 3).join(', ') + (paper.authors.length > 3 ? ' et al.' : ''));
        }
        if (paper.abstract) {
          const preview = paper.abstract.length > 200 ? paper.abstract.slice(0, 200) + '...' : paper.abstract;
          console.log(chalk.bold('Abstract: ') + preview);
        }
        console.log(chalk.bold('Source:   ') + (paper.source || 'unknown'));
        console.log(chalk.bold('Peer reviewed: ') + (paper.peerReviewed ? chalk.green('yes') : chalk.yellow('no')));

        const saveAnswer = await prompt('\nSave to KB? (y/n): ');
        if (saveAnswer.toLowerCase() !== 'y') {
          console.log('Aborted.');
          kb.close();
          return;
        }

        const category = await choose('\nCategory:', CATEGORIES);

        const name = (paper.title || identifier).slice(0, 120);
        const entry = {
          name,
          description: paper.abstract || `Paper: ${identifier}`,
          category,
          status: 'active',
          source: paper.source || '',
          sourceUrl: paper.sourceUrl || '',
          authors: paper.authors || [],
          profile: 'research',
          peerReviewed: paper.peerReviewed || false,
          confidence: {
            score: paper.peerReviewed ? 0.85 : 0.75,
            decayDays: 180,
          },
        };

        const saved = kb.addEntry(project, entry);
        kb.close();

        console.log(chalk.green('\nEntry ingested successfully.'));
        console.log(`  ID:       ${chalk.cyan(saved.id)}`);
        console.log(`  Name:     ${saved.name}`);
        console.log(`  Category: ${saved.category}`);
        console.log(`  Project:  ${project}\n`);
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
};
