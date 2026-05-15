'use strict';

// recall arch-audit — print the port → adapter map and surrounding
// architecture surfaces so reviewers can see hexagonal is real, not theater.
//
// Output covers three layers:
//   1. Engine (lib/meridian-core/): strict hexagonal with ports/ + adapters/
//      + composition root. Port -> adapter mapping listed explicitly.
//   2. Recall-cli core surfaces (lib/*.js): file-prefix-organized but with
//      real contracts (knowledge-lifecycle, promotion-gates, handoff-ledger,
//      feature-* registry).
//   3. Command groups (from core-feature-catalog): the driving-side adapters
//      that talk into the engine via ports.
//
// This is the one-command rebuttal to "your hexagonal is just folder theater."

const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const { table } = require('../format');
const catalog = require('../core-feature-catalog');

// Static map of engine ports -> known adapter implementations. Keep this in
// sync as new adapters land. Each entry is verified by checking the file
// exists on disk; arch-audit reports any drift.
const ENGINE_PORTS = [
  {
    port: 'IEntryRepository',
    portFile: 'lib/meridian-core/ports/IEntryRepository.js',
    adapters: ['KBStoreEntryRepository'],
    adapterFiles: ['lib/meridian-core/adapters/KBStoreEntryRepository.js'],
    purpose: 'MIF entry persistence (CRUD over the per-project KB)',
  },
  {
    port: 'ISearchEngine',
    portFile: 'lib/meridian-core/ports/ISearchEngine.js',
    adapters: ['HybridSearchEngine'],
    adapterFiles: ['lib/meridian-core/adapters/HybridSearchEngine.js'],
    purpose: 'Hybrid retrieval (BM25 + dense + RRF + reranker)',
  },
  {
    port: 'ISchemaValidator',
    portFile: 'lib/meridian-core/ports/ISchemaValidator.js',
    adapters: ['MifSchemaValidator'],
    adapterFiles: ['lib/meridian-core/adapters/MifSchemaValidator.js'],
    purpose: 'MIF entry schema validation (v3.x)',
  },
  {
    port: 'IRedactionService',
    portFile: 'lib/meridian-core/ports/IRedactionService.js',
    adapters: ['RedactionServiceAdapter'],
    adapterFiles: ['lib/meridian-core/adapters/RedactionServiceAdapter.js'],
    purpose: 'PII/PHI redaction at ingest boundary',
  },
  {
    port: 'ISigningService',
    portFile: 'lib/meridian-core/ports/ISigningService.js',
    adapters: ['Ed25519SigningService', 'NullSigningService'],
    adapterFiles: [
      'lib/meridian-core/adapters/Ed25519SigningService.js',
      'lib/meridian-core/adapters/NullSigningService.js',
    ],
    purpose: 'Entry signing (community mode = Ed25519; local mode = Null)',
  },
  {
    port: 'IDomainAdapter',
    portFile: 'lib/meridian-core/ports/IDomainAdapter.js',
    adapters: ['NullDomainAdapter'],
    adapterFiles: ['lib/meridian-core/adapters/NullDomainAdapter.js'],
    purpose: 'Domain-specific logic injection point (default: no-op)',
  },
  {
    port: 'ILLMProvider',
    portFile: 'lib/meridian-core/ports/ILLMProvider.js',
    adapters: ['OpenAICompatibleLLM'],
    adapterFiles: ['lib/meridian-core/adapters/OpenAICompatibleLLM.js'],
    purpose: 'LLM chat completion (Ollama / LM Studio / vLLM / OpenAI / Groq / ...)',
  },
  {
    port: 'IRelationRepository',
    portFile: 'lib/meridian-core/ports/IRelationRepository.js',
    adapters: ['GraphEngineRelationRepository'],
    adapterFiles: ['lib/meridian-core/adapters/GraphEngineRelationRepository.js'],
    purpose: 'Entry-relation graph queries (neighbors / contradictions / paths / auto-edges / stats)',
  },
];

// Recall-cli-level core surfaces. These are NOT in lib/meridian-core/ — they
// live at the outer lib/ as file-prefix-organized modules, but they enforce
// the trust model (lifecycle, promotion, audit, handoff) just the same.
const CLI_CORE_SURFACES = [
  { file: 'lib/knowledge-lifecycle.js', purpose: 'Entry state machine (draft → reviewed → trusted → retired)' },
  { file: 'lib/promotion-gates.js', purpose: 'Rules controlling which transitions are allowed' },
  { file: 'lib/agent-handoff-ledger.js', purpose: 'Append-only handoff ledger + isSignificantHandoff + validatePromotionReadiness' },
  { file: 'lib/knowledge-transition-ledger.js', purpose: 'Append-only KB state-transition log' },
  { file: 'lib/audit-debt.js', purpose: 'Audit-debt accumulation tracker' },
  { file: 'lib/audit-sediment.js', purpose: 'Sediment-style audit aggregation' },
  { file: 'lib/feature-registry.js', purpose: 'Feature self-registration + discovery' },
  { file: 'lib/feature-manifest.js', purpose: 'Per-feature manifest (name, version, declared capabilities)' },
  { file: 'lib/feature-capability.js', purpose: 'Declared KB read/write surface per feature' },
  { file: 'lib/feature-execution-gate.js', purpose: 'Runtime guard — blocks feature exec on missing declarations' },
  { file: 'lib/feature-run-ledger.js', purpose: 'Append-only feature-run outcome log' },
  { file: 'lib/core-feature-catalog.js', purpose: 'Built-in feature inventory' },
  { file: 'lib/handoff-promotion.js', purpose: 'Interim Trace Optimizer stub — tiered IL→KB promotion' },
  { file: 'lib/trace-optimizer/failure-basin-detector.js', purpose: 'Trace Optimizer Slice 0 — failure basin clustering' },
];

function repoRoot() {
  return path.resolve(__dirname, '..', '..');
}

function exists(rel) {
  return fs.existsSync(path.join(repoRoot(), rel));
}

function statusIcon(ok) {
  return ok ? chalk.green('✓') : chalk.red('✗');
}

module.exports = function(program) {
  program
    .command('arch-audit')
    .description('Print the port → adapter map + recall-cli core surfaces + command-group catalog. One-shot evidence-of-hexagonal.')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      const root = repoRoot();

      const enginePortRows = ENGINE_PORTS.map((p) => ({
        port: p.port,
        purpose: p.purpose,
        portFile: p.portFile,
        portExists: exists(p.portFile),
        adapters: p.adapters.map((name, i) => ({
          name,
          file: p.adapterFiles[i],
          exists: exists(p.adapterFiles[i]),
        })),
      }));

      const coreRows = CLI_CORE_SURFACES.map((s) => ({
        file: s.file,
        purpose: s.purpose,
        exists: exists(s.file),
      }));

      const commandGroups = (catalog.BUILT_FEATURE_GROUPS || [])
        .filter((g) => g && g.group && Array.isArray(g.commands));

      const result = {
        repoRoot: root,
        engineLayer: {
          path: 'lib/meridian-core/',
          ports: enginePortRows,
          compositionRoot: 'lib/meridian-core/lib/buildLocalRegistry.js',
          compositionExists: exists('lib/meridian-core/lib/buildLocalRegistry.js'),
        },
        cliCoreSurfaces: coreRows,
        commandGroups: commandGroups.map((g) => ({
          group: g.group,
          source: g.source,
          commandCount: g.commands.length,
          commands: g.commands,
        })),
        summary: {
          engineAllResolved: enginePortRows.every((p) => p.portExists && p.adapters.every((a) => a.exists)),
          coreAllResolved: coreRows.every((r) => r.exists),
          totalEnginePortAdapterPairs: enginePortRows.reduce((acc, p) => acc + p.adapters.length, 0),
          totalCoreSurfaces: coreRows.length,
          totalCommandGroups: commandGroups.length,
        },
      };

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.bold('\nRecall Meridian — Architecture Audit\n'));
      console.log(`Repo root:        ${root}`);
      console.log(`Engine path:      lib/meridian-core/`);
      console.log(`Composition root: ${statusIcon(result.engineLayer.compositionExists)}  ${result.engineLayer.compositionRoot}`);

      console.log(chalk.bold('\n# Engine layer — strict hexagonal (ports + adapters)\n'));
      const engineTable = [];
      for (const row of enginePortRows) {
        const adapterList = row.adapters
          .map((a) => `${statusIcon(a.exists)} ${a.name}`)
          .join('\n');
        engineTable.push([
          `${statusIcon(row.portExists)} ${row.port}`,
          adapterList,
          row.purpose,
        ]);
      }
      table(engineTable, ['Port', 'Adapter(s)', 'Purpose']);

      console.log(chalk.bold('\n# Recall-cli core surfaces — file-prefix-organized but contract-enforced\n'));
      const coreTable = coreRows.map((row) => [
        statusIcon(row.exists),
        row.file,
        row.purpose,
      ]);
      table(coreTable, ['', 'File', 'Purpose']);

      console.log(chalk.bold('\n# Command groups — driving-side adapters\n'));
      const cmdTable = commandGroups.map((g) => [
        g.group,
        String(g.commands.length),
        g.commands.slice(0, 6).join(', ') + (g.commands.length > 6 ? `, +${g.commands.length - 6}` : ''),
      ]);
      table(cmdTable, ['Group', 'Cmds', 'Commands (truncated)']);

      console.log(chalk.bold('\n# Summary\n'));
      console.log(`  Engine port/adapter pairs:  ${result.summary.totalEnginePortAdapterPairs} ${result.summary.engineAllResolved ? chalk.green('(all resolved)') : chalk.red('(drift detected)')}`);
      console.log(`  Recall-cli core surfaces:   ${result.summary.totalCoreSurfaces} ${result.summary.coreAllResolved ? chalk.green('(all resolved)') : chalk.red('(drift detected)')}`);
      console.log(`  Command groups registered:  ${result.summary.totalCommandGroups}`);

      if (!result.summary.engineAllResolved || !result.summary.coreAllResolved) {
        console.log(chalk.yellow('\n  Drift means: a port/adapter/surface is referenced in the audit map but the file is missing. Update lib/commands/arch-audit.js or restore the file.'));
        process.exitCode = 1;
      }
      console.log('');
    });
};
