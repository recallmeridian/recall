'use strict';

// recall specialist — CLI for the local specialist execution layer.
//
// Note: this is the EXECUTION half. The persistence/registry half lives
// in lib/intelligence-specialists.js (parallel agent's work, in-flight
// at time of writing). When that lands, this CLI can grow integrations
// like `--register` and `--load-from-registry`. For now it operates on
// bundle files under lib/specialists/<id>.js.

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const cliConfig = require('../cli-config');
const meridianCore = require('../meridian-core');
const { runSpecialist } = require('../specialist-runner');

// Routes the LLM through the engine store's getLlmProvider() — closes the
// boundary-audit (2026-05-12) finding about direct adapter construction.
function buildLlmProvider() {
  const cfg = cliConfig.read();
  const store = meridianCore.init(cliConfig.getDataDir(), { llm: cfg.llm });
  try {
    return store.getLlmProvider();
  } finally {
    if (typeof store.close === 'function') store.close();
  }
}

function specialistDir() {
  return path.resolve(__dirname, '..', 'specialists');
}

function listAvailableSpecialists() {
  const dir = specialistDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => {
      try {
        const mod = require(path.join(dir, name));
        return {
          file: name,
          id: mod.id || (mod.specialist && mod.specialist.id) || name.replace(/\.js$/, ''),
          version: mod.version || (mod.specialist && mod.specialist.version),
          name: mod.specialist && mod.specialist.name,
          description: mod.specialist && mod.specialist.description,
        };
      } catch (err) {
        return { file: name, error: err.message };
      }
    });
}

function loadSpecialist(idOrFile) {
  // Try as id (lookup in lib/specialists/<id>.js).
  const direct = path.join(specialistDir(), `${idOrFile}.js`);
  if (fs.existsSync(direct)) {
    const mod = require(direct);
    return mod.specialist || mod;
  }
  // Try as filesystem path.
  const asPath = path.resolve(idOrFile);
  if (fs.existsSync(asPath)) {
    const mod = require(asPath);
    return mod.specialist || mod;
  }
  throw new Error(`Specialist not found: ${idOrFile}. Looked under lib/specialists/${idOrFile}.js and at ${asPath}.`);
}

function readInput(opts) {
  if (opts.inputFile) return fs.readFileSync(path.resolve(opts.inputFile), 'utf8');
  if (opts.input) return opts.input;
  // Read from stdin if no input provided
  if (!process.stdin.isTTY) {
    return fs.readFileSync(0, 'utf8');
  }
  return '';
}

module.exports = function(program) {
  const command = program
    .command('specialist')
    .description('Local specialist execution layer: run / list / show versioned-bundle specialists against the configured LLMProvider');

  command
    .command('list')
    .description('List specialists available under lib/specialists/')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      const list = listAvailableSpecialists();
      if (opts.json) {
        console.log(JSON.stringify({ specialists: list }, null, 2));
        return;
      }
      console.log(chalk.bold('\nAvailable Specialists\n'));
      if (list.length === 0) {
        console.log(chalk.gray('No specialists found under lib/specialists/.'));
        return;
      }
      for (const s of list) {
        if (s.error) {
          console.log(`  ${chalk.red('✗')} ${s.file}  (load error: ${s.error})`);
        } else {
          console.log(`  ${chalk.cyan(s.id)}  v${s.version}  — ${s.name}`);
          if (s.description) console.log(`    ${chalk.dim(s.description)}`);
        }
      }
      console.log('');
    });

  command
    .command('show <id>')
    .description('Show a specialist bundle (manifest summary, retrieval recipe, eval cases)')
    .option('--json', 'Print full bundle as JSON')
    .action((id, opts) => {
      try {
        const specialist = loadSpecialist(id);
        if (opts.json) {
          // Strip the user-template function for JSON output
          const safe = { ...specialist, promptTemplates: { system: specialist.promptTemplates.system, userTemplate: '<function>' } };
          console.log(JSON.stringify(safe, null, 2));
          return;
        }
        console.log(chalk.bold(`\nSpecialist: ${specialist.id}  v${specialist.version}\n`));
        console.log(`Name:        ${specialist.name}`);
        console.log(`Description: ${specialist.description}`);
        console.log(`Capabilities: ${(specialist.declaredCapabilities || []).join(', ')}`);
        console.log(`Required ports: ${(specialist.requiredPorts || []).join(', ')}`);
        console.log(chalk.bold('\nRetrieval recipe:'));
        const queries = (specialist.retrievalRecipe && specialist.retrievalRecipe.queries) || [];
        const defaultProject = specialist.retrievalRecipe && specialist.retrievalRecipe.defaultProject;
        if (defaultProject) console.log(`  defaultProject: ${defaultProject}`);
        queries.forEach((q) => {
          console.log(`  - ${q.category} (limit ${q.limit || 10}${q.project ? ', project=' + q.project : ''})`);
        });
        const evalCount = (specialist.evaluationCases || []).length;
        console.log(chalk.bold('\nEvaluation cases:') + ` ${evalCount}`);
        (specialist.evaluationCases || []).slice(0, 5).forEach((c) => {
          console.log(`  - ${c.id}: ${c.description}`);
        });
        console.log('');
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('run <id>')
    .description('Run a specialist against an input. Reads input from --input, --input-file, or stdin.')
    .option('--input <text>', 'Input text inline (mutually exclusive with --input-file)')
    .option('--input-file <path>', 'Read input from file')
    .option('--project <id>', 'Override the recipe defaultProject')
    .option('--temperature <t>', 'LLM temperature')
    .option('--include-context', 'Include retrieved KB entries in the output JSON')
    .option('--include-raw', 'Include raw LLM response content in the output JSON')
    .option('--json', 'Print result as JSON')
    .action(async (id, opts) => {
      try {
        const specialist = loadSpecialist(id);
        const input = readInput(opts);
        if (!input || !input.trim()) {
          console.error(chalk.red('No input provided. Use --input, --input-file, or pipe via stdin.'));
          process.exitCode = 1;
          return;
        }
        const llm = buildLlmProvider();
        const kb = meridianCore.init(cliConfig.getDataDir());
        try {
          const result = await runSpecialist(specialist, input, {
            llmProvider: llm,
            kb,
            project: opts.project,
          }, {
            temperature: opts.temperature !== undefined ? Number(opts.temperature) : undefined,
            includeRetrievedContext: Boolean(opts.includeContext),
            includeRawResponse: Boolean(opts.includeRaw),
          });
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          console.log(chalk.bold(`\nSpecialist Run: ${result.specialistId} v${result.specialistVersion}\n`));
          console.log(`Model:           ${result.model}`);
          console.log(`Finish reason:   ${result.finishReason}`);
          console.log(`Retrieved:       ${result.retrievedContextCount} KB entries`);
          console.log(`Parse:           ${result.parseFailed ? chalk.red('FAILED') : chalk.green('ok')}`);
          if (result.output) {
            console.log(chalk.bold('\nReview:\n'));
            console.log(JSON.stringify(result.output, null, 2));
          } else if (result.rawResponseContent) {
            console.log(chalk.bold('\nRaw response (parse failed):\n'));
            console.log(result.rawResponseContent);
          }
          console.log('');
        } finally {
          if (kb && typeof kb.close === 'function') kb.close();
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });
};
