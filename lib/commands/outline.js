'use strict';

const path = require('path');
const os = require('os');
const {
  gatherProjectStatus, loadAlignment, groupByPeak,
  renderMarkdown, regenerate,
} = require('../strategic-outline');
const fs = require('fs');

function defaultRoot() {
  return path.join(os.homedir(), '.recall');
}

function listProjectIds(rootDir) {
  const configPath = path.join(rootDir, 'config.json');
  if (!fs.existsSync(configPath)) return [];
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return Array.isArray(cfg.projects) ? cfg.projects.map((p) => p && p.id).filter(Boolean) : [];
  } catch (_e) {
    return [];
  }
}

module.exports = function registerOutline(program) {
  program
    .command('outline')
    .description('Generate the strategic outline (peak-grouped open-work view)')
    .option('--print', 'Print markdown to stdout without writing to disk')
    .option('--write', 'Write strategic-outline.{md,html} to <root> (default if neither flag given)')
    .option('--root <path>', 'Recall root dir', defaultRoot())
    .action((opts) => {
      const root = opts.root;
      if (opts.print) {
        const ids = listProjectIds(root);
        const statuses = ids.map((id) => gatherProjectStatus(root, id));
        const alignment = loadAlignment(root);
        const grouped = groupByPeak(statuses, alignment);
        const md = renderMarkdown(grouped, alignment, { generatedAt: new Date().toISOString(), daysInvisible: 0 });
        process.stdout.write(md);
        return;
      }
      // default: --write
      const result = regenerate(root);
      console.log('Strategic outline regenerated');
      console.log(`  ${result.markdownPath}`);
      console.log(`  ${result.htmlPath}`);
      console.log(`  ${result.projectCount} projects scanned`);
    });
};
