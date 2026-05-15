'use strict';

const chalk = require('chalk');
const https = require('https');
const http = require('http');
const meridian = require('../meridian-core');
const cliConfig = require('../cli-config');
const { prompt, choose } = require('../prompt');

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + (parsed.search || ''),
      method: 'GET',
      headers: { ...headers },
    };
    const req = lib.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (_) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = function(program) {
  program
    .command('pull <query>')
    .description('Pull KB entries from a remote server')
    .option('-p, --project <project>', 'Target project to save results into')
    .action(async (query, opts) => {
      try {
        const serverUrl = cliConfig.get('serverUrl');
        const apiKey = cliConfig.get('apiKey');

        if (!serverUrl) {
          console.error(chalk.red("No server configured. Run 'meridian config set serverUrl <url>' first."));
          process.exit(1);
        }

        const kb = meridian.init(cliConfig.getDataDir());

        // Resolve project
        let project = opts.project || cliConfig.get('defaultProject');
        if (!project) {
          const projects = kb.listProjects();
          if (projects.length === 0) {
            console.error(chalk.red('No local projects found. Run "meridian init" first.'));
            kb.close();
            process.exit(1);
          }
          const names = projects.map(p => p.id);
          project = await choose('\nSelect project to save into:', names);
        }

        const authHeaders = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
        const encodedQuery = encodeURIComponent(query);

        console.log(chalk.bold(`\nSearching remote for: "${query}"\n`));

        let results;
        try {
          const res = await httpGet(`${serverUrl}/api/search?q=${encodedQuery}`, authHeaders);
          if (res.status !== 200) {
            console.error(chalk.red(`Server error: HTTP ${res.status}`));
            kb.close();
            process.exit(1);
          }
          results = Array.isArray(res.body) ? res.body : (res.body.results || res.body.entries || []);
        } catch (err) {
          console.error(chalk.red(`Failed to reach server: ${err.message}`));
          kb.close();
          process.exit(1);
        }

        if (results.length === 0) {
          console.log(chalk.yellow('No results found.'));
          kb.close();
          return;
        }

        // Display results
        results.forEach((e, i) => {
          const preview = (e.description || '').slice(0, 80);
          console.log(`  ${chalk.cyan(i + 1 + '.')} ${chalk.bold(e.name || e.id)}`);
          console.log(`     ${e.category || ''}  â€”  ${preview}${preview.length === 80 ? '...' : ''}`);
        });

        const answer = await prompt(`\nWhich entries to save locally? (comma-separated numbers, or 'all'): `);

        let selected;
        if (answer.toLowerCase() === 'all') {
          selected = results;
        } else {
          const indices = answer.split(',').map(s => parseInt(s.trim(), 10) - 1).filter(n => n >= 0 && n < results.length);
          selected = indices.map(i => results[i]);
        }

        if (selected.length === 0) {
          console.log('Nothing selected.');
          kb.close();
          return;
        }

        let saved = 0;
        let skipped = 0;

        for (const entry of selected) {
          // Strip server-specific fields before local save
          const { _staleness, ...clean } = entry;
          try {
            kb.addEntry(project, {
              ...clean,
              projectId: project,
            });
            console.log(chalk.green(`  Saved: ${entry.id || entry.name}`));
            saved++;
          } catch (err) {
            if (err.constructor && err.constructor.name === 'DuplicateEntryError') {
              console.log(chalk.yellow(`  Skipped (already exists): ${entry.id || entry.name}`));
              skipped++;
            } else {
              console.log(chalk.red(`  Error saving ${entry.id || entry.name}: ${err.message}`));
              skipped++;
            }
          }
        }

        kb.close();
        console.log(`\nDone: ${chalk.green(saved + ' saved')}, ${skipped} skipped.`);
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
};
