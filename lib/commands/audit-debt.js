'use strict';

const chalk = require('chalk');
const meridian = require('../meridian-core');
const cliConfig = require('../cli-config');
const auditDebt = require('../audit-debt');
const { table } = require('../format');

function getKb() {
  return meridian.init(cliConfig.getDataDir());
}

function printFindings(findings) {
  if (findings.length === 0) {
    console.log(chalk.gray('No audit debt found.'));
    return;
  }
  table(findings.map((finding) => [
    finding.id,
    finding.severity,
    finding.status,
    finding.openedAt,
    finding.closedInCommit || '',
    finding.title,
  ]), ['ID', 'Severity', 'Status', 'Opened', 'Closed Commit', 'Title']);
}

module.exports = function(program) {
  const command = program
    .command('audit-debt')
    .description('Track open findings parsed from claude-audit-result-*.md files');

  command
    .command('scan')
    .description('Parse claude-audit-result-*.md files into Recall audit-debt storage')
    .option('--root <path>', 'Root folder to scan', process.cwd())
    .option('--json', 'Print scan result as JSON')
    .action((opts) => {
      const kb = getKb();
      try {
        const result = auditDebt.scanAuditDebt(kb, opts.root);
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.bold('\nAudit Debt Scan\n'));
        console.log(`Root:     ${chalk.cyan(result.rootPath)}`);
        console.log(`Files:    ${result.fileCount}`);
        console.log(`Findings: ${result.findingCount}`);
        console.log(`Open:     ${result.openCount}`);
        console.log(`Closed:   ${result.closedCount}`);
        console.log('');
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      } finally {
        kb.close();
      }
    });

  command
    .command('list')
    .description('List tracked audit debt')
    .option('--status <status>', 'Filter by status, e.g. open or closed')
    .option('--severity <severity>', 'Filter by severity, e.g. high')
    .option('--audit-id <id>', 'Filter by source audit id')
    .option('--limit <n>', 'Maximum rows to print', '200')
    .option('--scan', 'Scan the current root before listing')
    .option('--root <path>', 'Root folder for --scan', process.cwd())
    .option('--json', 'Print findings as JSON')
    .action((opts) => {
      const kb = getKb();
      try {
        if (opts.scan) auditDebt.scanAuditDebt(kb, opts.root);
        const findings = auditDebt.listDebt(kb, opts);
        if (opts.json) {
          console.log(JSON.stringify({ findings }, null, 2));
          return;
        }
        console.log(chalk.bold('\nAudit Debt\n'));
        printFindings(findings);
        console.log('');
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      } finally {
        kb.close();
      }
    });

  command
    .command('close <id>')
    .description('Mark an audit finding as closed')
    .requiredOption('--commit <sha>', 'Commit that closed the finding')
    .option('--json', 'Print the closed finding as JSON')
    .action((id, opts) => {
      const kb = getKb();
      try {
        const finding = auditDebt.closeDebt(kb, id, { commit: opts.commit });
        if (opts.json) {
          console.log(JSON.stringify({ finding }, null, 2));
          return;
        }
        console.log(chalk.green('Audit debt closed.'));
        console.log(`  ID:     ${chalk.cyan(finding.id)}`);
        console.log(`  Commit: ${finding.closedInCommit}`);
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      } finally {
        kb.close();
      }
    });
};
