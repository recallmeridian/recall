'use strict';

const chalk = require('chalk');
const cliConfig = require('../cli-config');

const VALID_KEYS = ['serverUrl', 'apiKey', 'defaultProject'];

// Well-known provider presets. Lets `recall config llm --provider openai`
// fill baseUrl automatically without making the user remember the URL.
const PROVIDER_PRESETS = {
  openai:    { baseUrl: 'https://api.openai.com/v1' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1' },
  groq:      { baseUrl: 'https://api.groq.com/openai/v1' },
  ollama:    { baseUrl: 'http://localhost:11434/v1' },
  lmstudio:  { baseUrl: 'http://localhost:1234/v1' },
  openrouter:{ baseUrl: 'https://openrouter.ai/api/v1' },
  together:  { baseUrl: 'https://api.together.xyz/v1' },
  fireworks: { baseUrl: 'https://api.fireworks.ai/inference/v1' },
};

function maskKey(k) {
  if (!k) return '(not set)';
  if (k.length < 14) return '(set, short)';
  return k.slice(0, 8) + '...' + k.slice(-4);
}

module.exports = function(program) {
  program
    .command('config [action] [key] [value]')
    .description('View or set CLI configuration (serverUrl, apiKey, defaultProject)')
    .action((action, key, value) => {
      try {
        // "meridian config" or "meridian config get" — print all
        if (!action || action === 'get') {
          if (!key) {
            const cfg = cliConfig.read();
            console.log(chalk.bold('\nMeridian CLI Configuration\n'));
            for (const [k, v] of Object.entries(cfg)) {
              const display = k === 'apiKey' && v ? v.slice(0, 6) + '...' : (v || chalk.dim('(not set)'));
              console.log(`  ${chalk.cyan(k.padEnd(20))} ${display}`);
            }
            console.log(`\n  Config file: ${chalk.dim(cliConfig.CONFIG_PATH)}\n`);
          } else {
            const val = cliConfig.get(key);
            if (val === undefined) {
              console.error(chalk.red(`Unknown key: ${key}`));
              console.log(`  Valid keys: ${VALID_KEYS.join(', ')}`);
              process.exit(1);
            }
            const display = key === 'apiKey' && val ? val.slice(0, 6) + '...' : (val || '(not set)');
            console.log(`${key}: ${display}`);
          }
          return;
        }

        if (action === 'set') {
          if (!key) {
            console.error(chalk.red('Usage: meridian config set <key> <value>'));
            console.log(`  Valid keys: ${VALID_KEYS.join(', ')}`);
            process.exit(1);
          }
          if (!VALID_KEYS.includes(key)) {
            console.error(chalk.red(`Unknown key: "${key}"`));
            console.log(`  Valid keys: ${VALID_KEYS.join(', ')}`);
            process.exit(1);
          }
          if (value === undefined) {
            console.error(chalk.red(`Usage: meridian config set ${key} <value>`));
            process.exit(1);
          }
          cliConfig.set(key, value);
          const display = key === 'apiKey' ? value.slice(0, 6) + '...' : value;
          console.log(chalk.green(`  Set ${key} = ${display}`));
          return;
        }

        console.error(chalk.red(`Unknown action: "${action}". Use "get" or "set".`));
        process.exit(1);
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });

  // ---------------------------------------------------------------------
  // recall config llm — manage the LLM provider block in cli-config.json.
  // Without flags, prints the current LLM config (apiKey masked). With
  // flags, partially updates the block.
  //
  //   recall config llm                              show current llm config
  //   recall config llm --provider openai            switch to openai preset
  //   recall config llm --provider openai --model gpt-4o-mini --api-key sk-...
  //   recall config llm --base-url http://localhost:11434/v1 --model qwen2.5:14b
  //
  // Presets fill baseUrl automatically: openai, anthropic, groq, ollama,
  // lmstudio, openrouter, together, fireworks. Override with --base-url.
  // ---------------------------------------------------------------------
  program
    .command('config-llm')
    .alias('llm-config')
    .description('View or update the LLM provider configuration (provider, baseUrl, model, apiKey)')
    .option('--provider <name>', 'Provider preset (openai|anthropic|groq|ollama|lmstudio|openrouter|together|fireworks)')
    .option('--base-url <url>', 'Override baseUrl (otherwise filled from --provider preset)')
    .option('--model <name>', 'Model id (e.g. gpt-4o-mini, claude-haiku-4-5-20251001, llama-3.3-70b-versatile)')
    .option('--api-key <key>', 'API key for the provider')
    .option('--json', 'Print current config as JSON (apiKey masked)')
    .action((opts) => {
      try {
        const cfg = cliConfig.read();
        const hasUpdate = Boolean(opts.provider || opts.baseUrl || opts.model || opts.apiKey);

        if (!hasUpdate) {
          const llm = cfg.llm || {};
          if (opts.json) {
            console.log(JSON.stringify({ ...llm, apiKey: maskKey(llm.apiKey) }, null, 2));
          } else {
            console.log(chalk.bold('\nLLM Configuration\n'));
            console.log(`  ${chalk.cyan('provider'.padEnd(12))} ${llm.provider || chalk.dim('(not set)')}`);
            console.log(`  ${chalk.cyan('baseUrl'.padEnd(12))} ${llm.baseUrl || chalk.dim('(not set)')}`);
            console.log(`  ${chalk.cyan('model'.padEnd(12))} ${llm.model || chalk.dim('(not set)')}`);
            console.log(`  ${chalk.cyan('apiKey'.padEnd(12))} ${maskKey(llm.apiKey)}`);
            console.log('');
            console.log(chalk.dim('  Set with: recall config-llm --provider <name> --model <id> --api-key <key>'));
            console.log(chalk.dim('  Presets:  ' + Object.keys(PROVIDER_PRESETS).join(', ')));
            console.log('');
          }
          return;
        }

        // Apply updates. Start from existing llm block so partial updates
        // keep prior values.
        const llm = { ...(cfg.llm || {}) };
        if (opts.provider) {
          if (!PROVIDER_PRESETS[opts.provider] && !opts.baseUrl) {
            console.error(chalk.red(`Unknown provider preset: "${opts.provider}"`));
            console.log(`  Known presets: ${Object.keys(PROVIDER_PRESETS).join(', ')}`);
            console.log('  Pass --base-url explicitly for custom providers.');
            process.exit(1);
          }
          llm.provider = opts.provider;
          if (PROVIDER_PRESETS[opts.provider]) {
            llm.baseUrl = PROVIDER_PRESETS[opts.provider].baseUrl;
          }
        }
        if (opts.baseUrl) llm.baseUrl = opts.baseUrl;
        if (opts.model) llm.model = opts.model;
        if (opts.apiKey) llm.apiKey = opts.apiKey;

        cfg.llm = llm;
        cliConfig.write(cfg);

        console.log(chalk.green('  LLM configuration updated.'));
        console.log(`  ${chalk.cyan('provider')} ${llm.provider || chalk.dim('(not set)')}`);
        console.log(`  ${chalk.cyan('baseUrl ')} ${llm.baseUrl || chalk.dim('(not set)')}`);
        console.log(`  ${chalk.cyan('model   ')} ${llm.model || chalk.dim('(not set)')}`);
        console.log(`  ${chalk.cyan('apiKey  ')} ${maskKey(llm.apiKey)}`);
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });
};
