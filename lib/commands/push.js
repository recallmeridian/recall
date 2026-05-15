'use strict';

const chalk = require('chalk');
const https = require('https');
const http = require('http');
const meridian = require('../meridian-core');
const cliConfig = require('../cli-config');
const { choose } = require('../prompt');
const { defaultAuditPath, recordDryRunPush } = require('../push-publication');

function httpPost(url, data, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const body = JSON.stringify(data);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
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
    req.write(body);
    req.end();
  });
}

module.exports = function(program) {
  program
    .command('push <project> [entry-id]')
    .description('Push local KB entries to a remote server')
    .option('--dry-run', 'Evaluate geomorphic publication policy without sending network requests')
    .option('--audit-path <path>', 'Write dry-run publication audit sediment to this JSONL file')
    .action(async (project, entryId, options) => {
      try {
        const dataDir = cliConfig.getDataDir();
        const kb = meridian.init(dataDir);
        let entries = [];

        if (entryId) {
          const entry = kb.getEntry(project, entryId);
          entries = [entry];
        } else {
          const all = kb.listEntries(project, { status: 'active' });
          if (all.length === 0) {
            console.log(chalk.yellow('No active entries found.'));
            kb.close();
            return;
          }
          const names = all.map(e => `${e.id}  â€”  ${e.name}`);
          names.push('All entries');
          const choice = await choose('\nWhich entry to push?', names);
          if (choice === 'All entries') {
            entries = all;
          } else {
            const idx = names.indexOf(choice);
            entries = [all[idx]];
          }
        }

        kb.close();

        if (options.dryRun) {
          let allowed = 0;
          let denied = 0;
          const auditPath = options.auditPath || defaultAuditPath(dataDir);

          for (const entry of entries) {
            const result = await recordDryRunPush(entry, project, {
              dataRoot: dataDir,
              auditPath,
              requestId: `push-dry-run:${project}:${entry.id}`,
            });

            if (result.decision === 'allow') {
              console.log(chalk.green(`  Would publish: ${entry.id}`));
              allowed++;
            } else {
              console.log(chalk.yellow(`  Would deny: ${entry.id} (${result.reasons.join(', ')})`));
              denied++;
            }
          }

          console.log(`\nDry run: ${chalk.green(allowed + ' allowed')}, ${denied > 0 ? chalk.yellow(denied + ' denied') : '0 denied'}`);
          console.log(chalk.gray(`Audit sediment: ${auditPath}`));
          return;
        }

        const serverUrl = cliConfig.get('serverUrl');
        const apiKey = cliConfig.get('apiKey');

        if (!serverUrl) {
          console.error(chalk.red("No server configured. Run 'meridian config set serverUrl <url>' first."));
          process.exit(1);
        }

        const authHeaders = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
        let succeeded = 0;
        let failed = 0;

        for (const entry of entries) {
          const payload = {
            ...entry,
            schemaVersion: '3.0',
            projectId: project,
          };
          try {
            const res = await httpPost(`${serverUrl}/api/entries`, payload, authHeaders);
            if (res.status >= 200 && res.status < 300) {
              console.log(chalk.green(`  Pushed: ${entry.id}`));
              succeeded++;
            } else {
              console.log(chalk.red(`  Failed: ${entry.id} (HTTP ${res.status})`));
              failed++;
            }
          } catch (err) {
            console.log(chalk.red(`  Error pushing ${entry.id}: ${err.message}`));
            failed++;
          }
        }

        console.log(`\nDone: ${chalk.green(succeeded + ' pushed')}, ${failed > 0 ? chalk.red(failed + ' failed') : '0 failed'}`);
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
};
