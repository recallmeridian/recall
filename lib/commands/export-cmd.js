'use strict';

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const meridian = require('../meridian-core');
const cliConfig = require('../cli-config');

function toMarkdown(entry) {
  const findings = Array.isArray(entry.keyFindings) && entry.keyFindings.length > 0
    ? entry.keyFindings.map(f => `- ${f}`).join('\n')
    : '- (none recorded)';

  const tags = Array.isArray(entry.tags) && entry.tags.length > 0
    ? entry.tags.join(', ')
    : '';

  const sourceLink = entry.sourceUrl
    ? `[${entry.source || entry.sourceUrl}](${entry.sourceUrl})`
    : (entry.source || '');

  return `---
id: ${entry.id || ''}
category: ${entry.category || ''}
status: ${entry.status || ''}
confidence: ${entry.confidence && entry.confidence.score !== undefined ? entry.confidence.score : ''}
source: ${entry.source || ''}
diseaseArea: ${entry.disease_area || ''}
---

# ${entry.name || entry.id}

${entry.description || ''}

## Key Findings
${findings}

## Tags
${tags}

## Source
${sourceLink}
`;
}

module.exports = function(program) {
  program
    .command('export <project>')
    .description('Export KB entries to Markdown files')
    .option('--format <format>', 'Output format (only "md" supported)', 'md')
    .action((project, opts) => {
      try {
        const kb = meridian.init(cliConfig.getDataDir());
        const entries = kb.listEntries(project);
        kb.close();

        if (entries.length === 0) {
          console.log(chalk.yellow(`No entries found in project "${project}".`));
          return;
        }

        const outputDir = path.join(process.cwd(), 'export', project);
        fs.mkdirSync(outputDir, { recursive: true });

        for (const entry of entries) {
          const filename = `${entry.id}.md`;
          const filepath = path.join(outputDir, filename);
          fs.writeFileSync(filepath, toMarkdown(entry), 'utf8');
        }

        console.log(chalk.green(`\nExported ${entries.length} entries to ./export/${project}/\n`));
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
};
