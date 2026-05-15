'use strict';

const chalk = require('chalk');
const meridian = require('../meridian-core');
const { getDataDir } = require('../cli-config');
const { formatCategory, formatConfidence, formatStaleness, table } = require('../format');
const { formatSecurityDryRun, summarizeSecurityDryRun } = require('../search-security-dry-run');
const { computeStaleness } = require('../meridian-core');
const { filterEntriesAsOf } = require('../temporal-memory');

function applyTemporalFilter(entries, opts) {
  if (!opts.asOf) return { entries, temporalSummary: null };
  const temporalSummary = filterEntriesAsOf(entries, {
    asOf: opts.asOf,
    requireCertainValidTime: opts.requireCertainValidTime === true,
  });
  return { entries: temporalSummary.entries, temporalSummary };
}

function formatTemporalWindow(entry) {
  if (!entry.temporal) return '';
  const from = entry.temporal.valid_from ? entry.temporal.valid_from.slice(0, 10) : '?';
  const to = entry.temporal.valid_to ? entry.temporal.valid_to.slice(0, 10) : 'now';
  const inferred = entry.temporal.valid_time_inferred ? ' inferred' : '';
  return `${from}..${to}${inferred}`;
}

module.exports = function(program) {
  program
    .command('search <project> <query>')
    .description('Full-text search KB entries in a project')
    .option('--relevance', 'Use TF-IDF relevance ranking instead of FTS/LIKE search')
    .option('--semantic', 'Use embedding-based semantic search (requires OPENAI_API_KEY)')
    .option('--hybrid', 'Use hybrid search: semantic + TF-IDF + confidence scoring (requires OPENAI_API_KEY)')
    .option('--related <entry-id>', 'Find entries related to a given entry ID by token overlap')
    .option('--security-dry-run', 'Show retrieval partition/security treatment without changing stored data')
    .option('--from <mode>', 'Security dry-run retrieval mode: normal, trusted, candidate, quarantine, or *', 'normal')
    .option('--allow-quarantine', 'Allow explicit quarantine inspection in security dry-run output')
    .option('--as-of <iso-date>', 'Show search results whose valid-time window includes this date/time')
    .option('--require-certain-valid-time', 'Exclude low-confidence inferred valid-time entries from temporal results')
    .action(async (project, query, opts) => {
      try {
        const kb = meridian.init(getDataDir());

        // --related flag: find entries by token overlap to a source entry
        if (opts.related) {
          const entryId = opts.related;
          let results = kb.queryEngine.getRelatedEntries(entryId, 10);
          const temporal = applyTemporalFilter(results, opts);
          results = temporal.entries;
          kb.close();

          const suffix = opts.asOf
            ? `${results.length} found as of "${opts.asOf}" (${temporal.temporalSummary.excluded.length} outside window, ${temporal.temporalSummary.abstentions.length} unknown)`
            : `${results.length} found`;
          console.log(chalk.bold(`\nEntries related to "${entryId}" (${suffix})\n`));

          if (results.length === 0) {
            console.log(chalk.gray('  No related entries found.\n'));
            return;
          }

          const rows = results.map(e => {
            const row = [
              e.id,
              e.name || '',
              formatCategory(e.category || ''),
              String(e._overlapScore),
            ];
            if (opts.asOf) row.push(formatTemporalWindow(e));
            return row;
          });

          const headers = ['ID', 'Name', 'Category', 'Overlap Score'];
          if (opts.asOf) headers.push('Valid Window');
          table(rows, headers);
          console.log('');
          return;
        }

        // --semantic flag: embedding cosine similarity search
        if (opts.semantic) {
          if (!kb.semanticSearch.isAvailable()) {
            kb.close();
            console.error(chalk.red('Error: Semantic search requires OPENAI_API_KEY or VOYAGE_API_KEY to be set.'));
            process.exit(1);
          }

          let results = await kb.semanticSearch.search(query, { project });
          const temporal = applyTemporalFilter(results, opts);
          results = temporal.entries;
          kb.close();

          const suffix = opts.asOf
            ? `${results.length} found as of "${opts.asOf}" (${temporal.temporalSummary.excluded.length} outside window, ${temporal.temporalSummary.abstentions.length} unknown)`
            : `${results.length} found`;
          console.log(chalk.bold(`\nSemantic search for "${query}" in "${project}" (${suffix})\n`));

          if (results.length === 0) {
            console.log(chalk.gray('  No semantically similar entries found.\n'));
            return;
          }

          const rows = results.map(e => {
            const row = [
              e.id,
              e.name || '',
              formatCategory(e.category || ''),
              typeof e._semanticScore === 'number' ? e._semanticScore.toFixed(4) : '-',
            ];
            if (opts.asOf) row.push(formatTemporalWindow(e));
            return row;
          });

          const headers = ['ID', 'Name', 'Category', 'Semantic Score'];
          if (opts.asOf) headers.push('Valid Window');
          table(rows, headers);
          console.log('');
          return;
        }

        // --hybrid flag: semantic + TF-IDF + confidence hybrid search
        if (opts.hybrid) {
          if (!kb.semanticSearch.isAvailable()) {
            kb.close();
            console.error(chalk.red('Error: Hybrid search requires OPENAI_API_KEY or VOYAGE_API_KEY to be set.'));
            process.exit(1);
          }

          let results = await kb.semanticSearch.hybridSearch(query, { project });
          const temporal = applyTemporalFilter(results, opts);
          results = temporal.entries;
          kb.close();

          const suffix = opts.asOf
            ? `${results.length} found as of "${opts.asOf}" (${temporal.temporalSummary.excluded.length} outside window, ${temporal.temporalSummary.abstentions.length} unknown)`
            : `${results.length} found`;
          console.log(chalk.bold(`\nHybrid search for "${query}" in "${project}" (${suffix})\n`));

          if (results.length === 0) {
            console.log(chalk.gray('  No entries found.\n'));
            return;
          }

          const rows = results.map(e => {
            const row = [
              e.id,
              e.name || '',
              formatCategory(e.category || ''),
              typeof e._hybridScore === 'number' ? e._hybridScore.toFixed(4) : '-',
              typeof e._semanticScore === 'number' ? e._semanticScore.toFixed(3) : '-',
              typeof e._tfidfScore === 'number' ? e._tfidfScore.toFixed(3) : '-',
            ];
            if (opts.asOf) row.push(formatTemporalWindow(e));
            return row;
          });

          const headers = ['ID', 'Name', 'Category', 'Hybrid', 'Semantic', 'TF-IDF'];
          if (opts.asOf) headers.push('Valid Window');
          table(rows, headers);
          console.log('');
          return;
        }

        // --relevance flag: TF-IDF ranked search
        if (opts.relevance) {
          let results = kb.queryEngine.relevanceSearch(query, { project });
          const temporal = applyTemporalFilter(results, opts);
          results = temporal.entries;
          kb.close();

          const suffix = opts.asOf
            ? `${results.length} found as of "${opts.asOf}" (${temporal.temporalSummary.excluded.length} outside window, ${temporal.temporalSummary.abstentions.length} unknown)`
            : `${results.length} found`;
          console.log(chalk.bold(`\nRelevance search for "${query}" in "${project}" (${suffix})\n`));

          if (results.length === 0) {
            console.log(chalk.gray('  No entries matched.\n'));
            return;
          }

          const rows = results.map(e => {
            const row = [
              e.id,
              e.name || '',
              formatCategory(e.category || ''),
              e._relevanceScore.toFixed(4),
            ];
            if (opts.asOf) row.push(formatTemporalWindow(e));
            return row;
          });

          const headers = ['ID', 'Name', 'Category', 'Relevance Score'];
          if (opts.asOf) headers.push('Valid Window');
          table(rows, headers);
          console.log('');
          return;
        }

        // Default: FTS/LIKE full-text search
        let entries = kb.search(project, query);
        const temporal = applyTemporalFilter(entries, opts);
        entries = temporal.entries;
        kb.close();

        if (opts.securityDryRun) {
          const summary = summarizeSecurityDryRun(entries, {
            from: opts.from,
            allowQuarantine: opts.allowQuarantine === true,
          });
          console.log(chalk.bold(`\nSearch security dry run for "${query}" in "${project}" (${entries.length} temporal results)\n`));
          console.log(formatSecurityDryRun(summary));
          console.log('');
          return;
        }

        const suffix = opts.asOf
          ? `${entries.length} found as of "${opts.asOf}" (${temporal.temporalSummary.excluded.length} outside window, ${temporal.temporalSummary.abstentions.length} unknown)`
          : `${entries.length} found`;
        console.log(chalk.bold(`\nSearch results for "${query}" in "${project}" (${suffix})\n`));

        if (entries.length === 0) {
          console.log(chalk.gray('  No entries matched.\n'));
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
