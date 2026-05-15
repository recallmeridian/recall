'use strict';

const chalk = require('chalk');

const CATEGORY_COLORS = {
  'mechanism': chalk.cyan,
  'experimental-finding': chalk.blue,
  'hypothesis': chalk.magenta,
  'failed-approach': chalk.red,
  'drug-target': chalk.green,
  'biomarker': chalk.yellow,
  'clinical-observation': chalk.magentaBright,
  'method': chalk.gray,
};

function formatCategory(category) {
  const color = CATEGORY_COLORS[category] || chalk.white;
  return color(category);
}

function formatConfidence(score) {
  const pct = Math.round((score || 0.5) * 100);
  if (pct >= 80) return chalk.green(`${pct}%`);
  if (pct >= 50) return chalk.yellow(`${pct}%`);
  return chalk.red(`${pct}%`);
}

function formatStaleness(staleness) {
  if (!staleness) return '';
  if (staleness.urgency === 'critical') return chalk.red('STALE');
  if (staleness.urgency === 'warning') return chalk.yellow('aging');
  return chalk.green('fresh');
}

function table(rows, headers) {
  if (rows.length === 0) {
    console.log(chalk.gray('  (no results)'));
    return;
  }

  // Calculate column widths
  const widths = headers.map((h, i) => {
    const maxData = Math.max(...rows.map(r => String(r[i] || '').length));
    return Math.max(h.length, Math.min(maxData, 50));
  });

  // Print header
  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join('  ');
  console.log(chalk.bold(headerLine));
  console.log(chalk.gray('─'.repeat(headerLine.length)));

  // Print rows
  for (const row of rows) {
    const line = row.map((cell, i) => {
      const s = String(cell || '');
      return s.length > widths[i] ? s.slice(0, widths[i] - 1) + '…' : s.padEnd(widths[i]);
    }).join('  ');
    console.log(line);
  }
}

module.exports = { formatCategory, formatConfidence, formatStaleness, table, CATEGORY_COLORS };
