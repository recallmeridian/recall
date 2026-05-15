'use strict';

// recall pattern-validate <vault-dir>
//
// Validates a Recall-Pattern markdown vault (the format defined in
// RECALL-PATTERN.md) WITHOUT requiring engine import. This is the
// safety net for pattern-only users — without it, drift accumulates
// silently and you only discover problems when you try to upgrade.
//
// What it checks (see lib/pattern-vault.js for the full rules):
//   • per-entry schema (id, name, description, status, confidence shape)
//   • duplicate ids across categories
//   • relationships.jsonl parse + structure
//   • relationship endpoints actually exist in the vault
//   • drift signals (high orphan ratio, confidence-not-calibrated, etc.)
//
// Output:
//   • Health score 0-100 + tier (excellent/good/fair/poor/critical)
//   • Findings grouped by level (error / warn / info)
//   • Per-category counts so you can see scope at a glance
//
// Flags:
//   --json      Print the full report as JSON (for piping to other tools)
//   --strict    Exit non-zero on warnings too (default: only errors trip exit)
//   --quiet     Suppress findings list; print the summary line only

const path = require('path');
const chalk = require('chalk');
const pv = require('../pattern-vault');

function fmtLevel(level) {
  if (level === 'error') return chalk.red('ERROR');
  if (level === 'warn')  return chalk.yellow('WARN ');
  if (level === 'info')  return chalk.gray('INFO ');
  return level;
}

function fmtScore(score, tier) {
  const colour = (
    tier === 'excellent' ? chalk.green :
    tier === 'good'      ? chalk.green :
    tier === 'fair'      ? chalk.yellow :
    tier === 'poor'      ? chalk.red :
                           chalk.red.bold
  );
  return colour(`${score}/100  (${tier})`);
}

module.exports = function(program) {
  program
    .command('pattern-validate <vault-dir>')
    .description('Validate a Recall-Pattern markdown vault: schema, relationships, drift signals. Returns a health score 0-100. No engine install or import required.')
    .option('--json', 'Print the full report as JSON')
    .option('--strict', 'Exit non-zero on warnings, not just errors')
    .option('--quiet', 'Print only the summary line; suppress finding list')
    .action((vaultDir, opts) => {
      let report;
      try {
        report = pv.validateVault(vaultDir);
      } catch (err) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
        } else {
          console.error(chalk.red(`pattern-validate error: ${err.message}`));
        }
        process.exitCode = 2;
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log('');
        console.log(chalk.cyan.bold('Recall-Pattern vault validation'));
        console.log('');
        console.log(`Vault:                   ${report.vaultDir}`);
        console.log(`Entries:                 ${report.entryCount} found, ${chalk.green(report.cleanEntries)} clean`);
        console.log(`Relationships:           ${report.relationshipCount} found, ${chalk.green(report.cleanRelationships)} clean`);
        console.log(`Categories:              ${report.categories.length}`);
        for (const c of report.categories) {
          console.log(`  - ${c.name}: ${c.count}`);
        }
        console.log('');
        console.log(`Health:                  ${fmtScore(report.healthScore, report.healthTier)}`);
        console.log(chalk.gray(`                         ${report.healthLabel}`));
        console.log('');
        console.log(`Findings:                ${chalk.red(report.errorCount + ' errors')}, ${chalk.yellow(report.warnCount + ' warnings')}, ${chalk.gray(report.infoCount + ' info')}`);

        if (!opts.quiet && report.findings.length > 0) {
          console.log('');
          console.log(chalk.cyan('Details (first 30):'));
          for (const f of report.findings.slice(0, 30)) {
            const where = f.at ? chalk.gray(` @ ${path.relative(report.vaultDir, f.at) || f.at}`) : '';
            const detail = f.detail ? `: ${f.detail}` : '';
            console.log(`  ${fmtLevel(f.level)}  ${chalk.cyan(f.code)}${where}${detail}`);
          }
          if (report.findings.length > 30) {
            console.log(chalk.gray(`  ... and ${report.findings.length - 30} more. Re-run with --json for the full list.`));
          }
        }
        console.log('');
        if (report.healthScore >= 90) {
          console.log(chalk.green('Vault is in great shape. Safe to import.'));
        } else if (report.healthScore >= 70) {
          console.log(chalk.green('Healthy vault. Warnings are worth a pass when you have time, not blockers.'));
        } else if (report.healthScore >= 50) {
          console.log(chalk.yellow('Some drift has built up. Try `recall import-vault <dir> --validate-only --repair` to see what auto-fixes would apply, or address findings manually.'));
        } else {
          console.log(chalk.red('Several structural issues to resolve before import. The findings above show what needs attention.'));
        }
        console.log('');
      }

      const hasErrors = report.errorCount > 0;
      const hasWarnings = report.warnCount > 0;
      if (hasErrors) process.exitCode = 1;
      else if (opts.strict && hasWarnings) process.exitCode = 1;
    });
};
