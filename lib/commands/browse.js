'use strict';

const chalk = require('chalk');
const meridian = require('../meridian-core');
const { getDataDir } = require('../cli-config');
const { formatCategory, formatConfidence, formatStaleness, table } = require('../format');
const { computeStaleness } = require('../meridian-core');
const { filterEntriesAsOf } = require('../temporal-memory');

function formatTemporalWindow(entry) {
  if (!entry.temporal) return '';
  const from = entry.temporal.valid_from ? entry.temporal.valid_from.slice(0, 10) : '?';
  const to = entry.temporal.valid_to ? entry.temporal.valid_to.slice(0, 10) : 'now';
  const inferred = entry.temporal.valid_time_inferred ? ' inferred' : '';
  return `${from}..${to}${inferred}`;
}

module.exports = function(program) {
  program
    .command('browse <project>')
    .description('Browse KB entries for a project')
    .option('--category <cat>', 'Filter by category')
    .option('--status <status>', 'Filter by status (active, retired, draft)')
    .option('--negative', 'Show only negative results')
    .option('--as-of <iso-date>', 'Show entries whose valid-time window includes this date/time')
    .option('--require-certain-valid-time', 'Exclude low-confidence inferred valid-time entries from temporal results')
    .action((project, opts) => {
      try {
        const kb = meridian.init(getDataDir());

        const filters = {};
        if (opts.category) filters.category = opts.category;
        if (opts.status) filters.status = opts.status;

        let entries = kb.listEntries(project, filters);

        if (opts.negative) {
          entries = entries.filter(e => e.isNegativeResult);
        }

        let temporalSummary = null;
        if (opts.asOf) {
          temporalSummary = filterEntriesAsOf(entries, {
            asOf: opts.asOf,
            requireCertainValidTime: opts.requireCertainValidTime === true,
          });
          entries = temporalSummary.entries;
        }

        kb.close();

        const suffix = opts.asOf
          ? ` valid as of "${opts.asOf}" (${entries.length} shown, ${temporalSummary.excluded.length} outside window, ${temporalSummary.abstentions.length} unknown)`
          : ` (${entries.length} total)`;
        console.log(chalk.bold(`\nEntries in "${project}"${suffix}\n`));

        if (entries.length === 0) {
          console.log(chalk.gray('  No entries found.\n'));
          return;
        }

        const rows = entries.map(e => {
          const staleness = computeStaleness(e);
          const row = [
            e.id,
            e.name || '',
            formatCategory(e.category || ''),
            formatConfidence(e.confidence && e.confidence.score),
            formatStaleness(staleness),
          ];
          if (opts.asOf) row.push(formatTemporalWindow(e));
          return row;
        });

        const headers = ['ID', 'Name', 'Category', 'Confidence', 'Staleness'];
        if (opts.asOf) headers.push('Valid Window');
        table(rows, headers);
        console.log('');
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
};
