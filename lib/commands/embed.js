'use strict';

const chalk = require('chalk');
const meridian = require('../meridian-core');
const { getDataDir } = require('../cli-config');

module.exports = function(program) {
  program
    .command('embed <project>')
    .description('Generate and store embeddings for all entries in a project (requires OPENAI_API_KEY)')
    .option('--force', 'Re-index all entries, even if already embedded')
    .action(async (project, opts) => {
      try {
        const kb = meridian.init(getDataDir());

        if (!kb.semanticSearch.isAvailable()) {
          kb.close();
          console.error(chalk.red('Error: Embedding requires OPENAI_API_KEY or VOYAGE_API_KEY to be set.'));
          console.error(chalk.gray('  Set the environment variable and retry:'));
          console.error(chalk.gray('    export OPENAI_API_KEY=sk-...'));
          process.exit(1);
        }

        // Verify project exists
        try {
          kb._assertProject(project);
        } catch (e) {
          kb.close();
          console.error(chalk.red(`Error: Project "${project}" not found.`));
          process.exit(1);
        }

        console.log(chalk.bold(`\nIndexing embeddings for project "${project}"...\n`));

        const startTime = Date.now();
        let lastPct = -1;

        const result = await kb.semanticSearch.indexAll(project, (indexed, total) => {
          const pct = Math.floor((indexed / total) * 100);
          if (pct !== lastPct && (pct % 10 === 0 || indexed === total)) {
            process.stdout.write(`\r  Progress: ${indexed}/${total} entries (${pct}%)  `);
            lastPct = pct;
          }
        });

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        process.stdout.write('\n');

        kb.close();

        if (result.indexed === result.total) {
          console.log(chalk.green(`\n  Done. Indexed ${result.indexed} entries in ${elapsed}s.\n`));
        } else {
          const skipped = result.total - result.indexed;
          console.log(chalk.yellow(`\n  Done. Indexed ${result.indexed}/${result.total} entries in ${elapsed}s.`));
          console.log(chalk.yellow(`  ${skipped} entries failed to embed (API errors â€” run again to retry).\n`));
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
};
