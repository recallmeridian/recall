'use strict';

// recall llm — top-level command group for LLMProvider config + diagnostics.
//
//   recall llm config --provider ollama --base-url http://localhost:11434/v1 --model llama3.2
//   recall llm config --provider openai --base-url https://api.openai.com/v1 --model gpt-4o-mini --api-key $OPENAI_API_KEY
//   recall llm config --provider lmstudio --base-url http://localhost:1234/v1 --model local-model
//   recall llm status
//   recall llm test "ping"
//
// All higher-level features (Trace Optimizer reflection, consolidation,
// harness recommendation) call the LLMProvider port; users only configure
// the provider once and every feature follows.

const chalk = require('chalk');
const cliConfig = require('../cli-config');
const meridian = require('../meridian-core');

function readLlmConfig() {
  const cfg = cliConfig.read();
  return cfg.llm || { provider: '', baseUrl: '', model: '', apiKey: '' };
}

function writeLlmConfig(patch) {
  const cfg = cliConfig.read();
  cfg.llm = { ...readLlmConfig(), ...patch };
  cliConfig.write(cfg);
  return cfg.llm;
}

function buildProvider() {
  // Routes through the engine via store.getLlmProvider() — closes the
  // boundary-audit finding about commands constructing OpenAICompatibleLLM
  // directly. The store itself stays unused for LLM-only commands; it's
  // there so future LLM operations can also access KB context via the
  // same handle without re-initializing.
  const store = meridian.init(cliConfig.getDataDir(), { llm: readLlmConfig() });
  try {
    return store.getLlmProvider();
  } finally {
    if (typeof store.close === 'function') store.close();
  }
}

function maskKey(key) {
  if (!key) return chalk.dim('(none)');
  return `${key.slice(0, 6)}...${key.slice(-2)}`;
}

module.exports = function(program) {
  const command = program
    .command('llm')
    .description('Configure and diagnose the OpenAI-compatible LLM provider used by features (Trace Optimizer reflection, consolidation, etc.)');

  command
    .command('config')
    .description('Set the LLM provider config. Any field can be set independently.')
    .option('--provider <name>', 'Display name: ollama | lmstudio | openai | vllm | groq | together | ...')
    .option('--base-url <url>', 'Endpoint ending in /v1, e.g. http://localhost:11434/v1')
    .option('--model <id>', 'Default model id, e.g. llama3.2, gpt-4o-mini')
    .option('--api-key <key>', 'Bearer token if the endpoint requires one (omit for local)')
    .option('--clear-api-key', 'Clear any stored API key (use after switching to a local provider)')
    .option('--json', 'Print resulting config as JSON')
    .action((opts) => {
      const patch = {};
      if (opts.provider !== undefined) patch.provider = opts.provider;
      if (opts.baseUrl !== undefined) patch.baseUrl = opts.baseUrl;
      if (opts.model !== undefined) patch.model = opts.model;
      if (opts.clearApiKey) patch.apiKey = '';
      else if (opts.apiKey !== undefined) patch.apiKey = opts.apiKey;

      const updated = writeLlmConfig(patch);

      if (opts.json) {
        console.log(JSON.stringify({ ...updated, apiKey: updated.apiKey ? '[set]' : '' }, null, 2));
        return;
      }
      console.log(chalk.bold('\nLLM Provider Config\n'));
      console.log(`  Provider:  ${updated.provider || chalk.dim('(not set)')}`);
      console.log(`  Base URL:  ${updated.baseUrl || chalk.dim('(not set)')}`);
      console.log(`  Model:     ${updated.model || chalk.dim('(not set)')}`);
      console.log(`  API key:   ${maskKey(updated.apiKey)}`);
      console.log(`\n  Config file: ${chalk.dim(cliConfig.CONFIG_PATH)}\n`);
    });

  command
    .command('status')
    .description('Print the current LLM provider config (API key masked)')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      const llm = readLlmConfig();
      const safe = { ...llm, apiKey: llm.apiKey ? '[set]' : '' };
      if (opts.json) {
        console.log(JSON.stringify(safe, null, 2));
        return;
      }
      console.log(chalk.bold('\nLLM Provider Status\n'));
      console.log(`  Provider:  ${llm.provider || chalk.dim('(not set)')}`);
      console.log(`  Base URL:  ${llm.baseUrl || chalk.dim('(not set)')}`);
      console.log(`  Model:     ${llm.model || chalk.dim('(not set)')}`);
      console.log(`  API key:   ${maskKey(llm.apiKey)}`);
      if (!llm.baseUrl || !llm.model) {
        console.log(chalk.yellow('\n  Not ready. Run: recall llm config --provider <name> --base-url <url> --model <id>'));
      } else {
        console.log(chalk.green('\n  Ready. Test with: recall llm test "hello"'));
      }
      console.log('');
    });

  command
    .command('test [prompt]')
    .description('Send a single user message and print the response (smoke test the configured provider)')
    .option('--system <text>', 'Optional system message')
    .option('--timeout <ms>', 'Override request timeout in milliseconds')
    .option('--json', 'Print full response as JSON')
    .action(async (prompt, opts) => {
      try {
        const provider = buildProvider();
        const messages = [];
        if (opts.system) messages.push({ role: 'system', content: opts.system });
        messages.push({ role: 'user', content: prompt || 'ping' });
        const result = await provider.chat({
          messages,
          ...(opts.timeout ? { timeoutMs: Number(opts.timeout) } : {}),
        });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.bold('\nLLM Test\n'));
        console.log(`Provider:     ${chalk.cyan(provider.describe().provider)}`);
        console.log(`Model:        ${result.model}`);
        console.log(`FinishReason: ${result.finishReason}`);
        if (result.usage) {
          console.log(`Usage:        prompt=${result.usage.prompt_tokens || '?'} completion=${result.usage.completion_tokens || '?'} total=${result.usage.total_tokens || '?'}`);
        }
        console.log(chalk.bold('\nResponse:\n'));
        console.log(result.content);
        console.log('');
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });
};
