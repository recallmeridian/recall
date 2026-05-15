#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const pkg = require('../package.json');
const { interpret } = require('../lib/nl-interpreter');
const cliConfig = require('../lib/cli-config');

const program = new Command();

program
  .name('recall')
  .description('Meridian — research knowledge base CLI')
  .version(pkg.version);

// Register commands
require('../lib/commands/init')(program);
require('../lib/commands/add')(program);
require('../lib/commands/search')(program);
require('../lib/commands/ingest')(program);
require('../lib/commands/push')(program);
require('../lib/commands/pull')(program);
require('../lib/commands/verify')(program);
require('../lib/commands/browse')(program);
require('../lib/commands/query')(program);
require('../lib/commands/status')(program);
require('../lib/commands/config')(program);
require('../lib/commands/export-cmd')(program);
require('../lib/commands/ui')(program);
require('../lib/commands/embed')(program);
require('../lib/commands/research')(program);
require('../lib/commands/import-history')(program);
require('../lib/commands/welcome')(program);
require('../lib/commands/brainstorm')(program);
require('../lib/commands/audit-debt')(program);
require('../lib/commands/intelligence')(program);
require('../lib/commands/feature')(program);
require('../lib/commands/knowledge')(program);
require('../lib/commands/open-source')(program);
require('../lib/commands/relay')(program);
require('../lib/commands/outline')(program);
require('../lib/commands/income')(program);
require('../lib/commands/trace')(program);
require('../lib/commands/llm')(program);
require('../lib/commands/arch-audit')(program);
require('../lib/commands/specialist')(program);
require('../lib/commands/consolidate')(program);
require('../lib/commands/security')(program);
require('../lib/commands/openclaw')(program);
require('../lib/commands/import-vault')(program);
require('../lib/commands/pattern-validate')(program);
const securityModule = require('../lib/commands/security');
if (securityModule.attachDreamCycleCommands) {
  // dream-* subcommands live on the same `security` parent
  const securityCmd = program.commands.find((c) => c.name() === 'security');
  if (securityCmd) securityModule.attachDreamCycleCommands(securityCmd);
}

// Short aliases
program
  .command('s <project> <query>')
  .description('Alias for search')
  .action((project, query) => {
    program.parse(['node', 'meridian', 'search', project, query]);
  });

program
  .command('q <project> [sql...]')
  .description('Alias for query')
  .action((project, sqlParts) => {
    program.parse(['node', 'meridian', 'query', project, ...(sqlParts || [])]);
  });

program
  .command('st')
  .description('Alias for status')
  .action(() => {
    program.parse(['node', 'meridian', 'status']);
  });

program
  .command('b <project>')
  .description('Alias for browse')
  .action((project) => {
    program.parse(['node', 'meridian', 'browse', project]);
  });

program
  .command('i <source>')
  .description('Alias for ingest')
  .action((source) => {
    program.parse(['node', 'meridian', 'ingest', source]);
  });

// Natural language fallback — catches unrecognized commands
program.on('command:*', function(operands) {
  const input = operands.join(' ');
  let config;
  try {
    config = cliConfig.read();
  } catch (_) {
    config = {};
  }

  const result = interpret(input, config.defaultProject || '');

  if (result) {
    console.log(chalk.gray(`Interpreting as: ${chalk.cyan(result.interpretation)}`));
    if (result.confidence < 0.4) {
      console.log(chalk.yellow(`(low confidence — ${Math.round(result.confidence * 100)}%). Run recall --help if this isn't right.`));
    }
    const newArgs = ['node', 'meridian', result.cmd, ...result.args];
    program.parse(newArgs);
  } else {
    console.error(chalk.red(`Unknown command: "${input}"`));
    console.error(chalk.gray('Try plain English (e.g. "search KRAS research") or run: recall --help'));
    process.exit(1);
  }
});

program.parse();
