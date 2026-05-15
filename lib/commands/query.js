'use strict';

const chalk = require('chalk');
const meridian = require('../meridian-core');
const { getDataDir } = require('../cli-config');
const { table } = require('../format');

module.exports = function(program) {
  program
    .command('query <project> [sql...]')
    .description('Run a TABLE query against a project (e.g. TABLE name, category FROM entries)')
    .action((project, sqlParts) => {
      try {
        if (!sqlParts || sqlParts.length === 0) {
          console.error(chalk.red('Error: query string is required.'));
          console.error(chalk.gray('Example: meridian query myproject TABLE name, category FROM entries'));
          process.exit(1);
        }

        const queryStr = sqlParts.join(' ');
        const kb = meridian.init(getDataDir());

        // Scope the query to the project by injecting a WHERE projectId filter if
        // the query source is "entries" and no WHERE is present; otherwise let the
        // engine handle it. The simplest approach: rely on the source-based filter
        // built into QueryEngine (it treats non-"entries" sources as category/projectId).
        // We expose kb.query() which delegates to store.queryEngine.query().
        const rows = kb.query(queryStr);
        kb.close();

        console.log(chalk.bold(`\nQuery: ${queryStr}\n`));

        if (rows.length === 0) {
          console.log(chalk.gray('  (no results)\n'));
          return;
        }

        // Derive headers from keys of first row
        const headers = Object.keys(rows[0]);
        const tableRows = rows.map(r => headers.map(h => r[h] == null ? '' : String(r[h])));
        table(tableRows, headers);
        console.log('');
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
};
