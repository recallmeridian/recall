'use strict';

// recall security — egress DLP CLI surface.
//
// Slice #2 of the 2026-05-12 OpenClaw security brainstorm. Pairs with
// the openclaw-governor specialist (Slice #1) and the publish-mirror
// gate wiring in lib/commands/open-source.js.

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const meridian = require('../meridian-core');
const cliConfig = require('../cli-config');
const { scanContent, scanFile, scanDir } = require('../security/egress-scanner');
const { appendScan, listScans, verifyLedger } = require('../security/scan-ledger');
const {
  createAnchor,
  listAnchors,
  getAnchor,
  verifyLedgerChain,
  verifyAgainstAnchor,
  computeAnchorState,
} = require('../security/graph-anchor');
const { buildSnapshotInputs } = require('../security/graph-snapshot');
const { evaluatePromotion } = require('../security/promotion-gate');
const { runDreamCycle, listDreamRuns, verifyDreamLedger } = require('../security/dream-cycle');
const { buildLiveCollectors } = require('../security/dream-collectors');
const { evaluateEnsemble, rulesEvaluator, heuristicEvaluator, llmEvaluator } = require('../security/evaluator-ensemble');
const { plantCanary, listCanaries, verifyCanaryLedger, detectCanaryHits } = require('../security/canary');
const { evaluateBridgeDegrees, suggestPruning } = require('../security/bridge-degree');
const { evaluateCorpus, listTiers, DEFAULT_TIERS } = require('../security/decay-policy');
const { evaluateDrift, summarizeLedger } = require('../security/drift-detector');
const { buildDashboard } = require('../security/dashboard');
const { recordNegativePromotion, summarizePenalty, listEvents: listNegPromEvents, verifyLedger: verifyNegPromLedger } = require('../security/negative-promotion');
const { computeHealth, appendHealthLedger, listHealthRuns, verifyHealthLedger } = require('../security/health');
const { buildSynthesis, appendSynthesisLedger, listSyntheses, verifySynthesisLedger, SYNTHESIS_TYPES } = require('../security/synthesis');
const { generateAttacks, runAdversaryRun, ATTACK_CATEGORIES } = require('../security/adversary-engine');
const auditIngest = require('../security/audit-ingest');
const { detectCollusion } = require('../security/collusion-detector');
const { buildSbom, verifyLockfile, auditDependencyShapes } = require('../security/supply-chain');
const archReview = require('../security/architect-review-queue');
const closedLoop = require('../intelligence-closed-loop');

function dataDir() {
  return cliConfig.getDataDir();
}

function printScanHuman(result) {
  const colour = result.decision === 'block' ? chalk.red : (result.decision === 'review' ? chalk.yellow : chalk.green);
  console.log('');
  console.log(colour.bold(`Egress Scan: ${result.decision.toUpperCase()}`));
  console.log(`Scan ID:      ${result.scanId}`);
  console.log(`Content hash: ${result.contentHash}`);
  console.log(`Bytes:        ${result.contentBytes}`);
  if (result.sourcePath) console.log(`Source:       ${result.sourcePath}`);
  if (result.target) console.log(`Target:       ${result.target}`);

  if (result.blockers && result.blockers.length) {
    console.log(chalk.red.bold(`\nBlockers (${result.blockers.length}):`));
    for (const b of result.blockers) {
      console.log(`  - [${b.detectorId}] ${b.issue}  → "${b.sample}"  @offset ${b.offset}`);
    }
  }
  if (result.warnings && result.warnings.length) {
    console.log(chalk.yellow.bold(`\nWarnings (${result.warnings.length}):`));
    for (const w of result.warnings) {
      console.log(`  - [${w.detectorId}] ${w.concern}  → "${w.sample}"  @offset ${w.offset}`);
    }
  }
  console.log('');
}

module.exports = function(program) {
  const command = program
    .command('security')
    .description('Recall security: egress DLP scan, scan ledger, verify. Slice #2 of the 2026-05-12 OpenClaw security brainstorm.');

  command
    .command('egress-scan')
    .description('Scan content for outbound DLP violations (secrets, private paths, raw-memory IDs, IPs). Returns allow/review/block. Appends to the hash-chained scan ledger.')
    .option('--content <text>', 'Inline string content to scan')
    .option('--file <path>', 'Path to a single file to scan')
    .option('--dir <path>', 'Path to a directory to scan recursively (default extensions: js/json/md/txt/html/css/yml/yaml/toml)')
    .option('--target <kind>', 'Outbound target descriptor (e.g. "moltbook:public", "github:public-mirror", "npm:registry")', '')
    .option('--no-ledger', 'Do not append the scan to the ledger (default: append)')
    .option('--include-allowed', 'When using --dir, include allowed files in the result (default: only review/block)')
    .option('--exit-on-block', 'Exit with code 2 if decision is block (useful for CI)')
    .option('--json', 'Print result as JSON')
    .action((opts) => {
      try {
        const sources = [opts.content, opts.file, opts.dir].filter(Boolean);
        if (sources.length !== 1) {
          throw new Error('Provide exactly one of --content, --file, or --dir');
        }
        const target = opts.target || null;
        const append = opts.ledger !== false;

        let result;
        if (opts.content) {
          result = scanContent({ content: opts.content, kind: 'inline', target });
          if (append) appendScan(result, { dataDir: dataDir() });
        } else if (opts.file) {
          result = scanFile(opts.file, { kind: 'file', target });
          if (append) appendScan(result, { dataDir: dataDir() });
        } else {
          result = scanDir(opts.dir, { kind: 'mirror-file', target, includeAllowed: opts.includeAllowed });
          if (append && Array.isArray(result.results)) {
            for (const r of result.results) {
              if (r.decision === 'block' || r.decision === 'review') appendScan(r, { dataDir: dataDir() });
            }
          }
        }

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (opts.dir) {
          console.log('');
          const decisionColour = result.summary.aggregateDecision === 'block' ? chalk.red : (result.summary.aggregateDecision === 'review' ? chalk.yellow : chalk.green);
          console.log(decisionColour.bold(`Egress Scan (dir): ${result.summary.aggregateDecision.toUpperCase()}`));
          console.log(`Files flagged:  ${result.summary.scannedFiles}`);
          console.log(`Block:          ${result.summary.blockCount}`);
          console.log(`Review:         ${result.summary.reviewCount}`);
          console.log(`Errors:         ${result.summary.errorCount}`);
          for (const r of result.results.slice(0, 30)) {
            const colour = r.decision === 'block' ? chalk.red : (r.decision === 'review' ? chalk.yellow : chalk.gray);
            console.log(colour(`  ${r.decision.padEnd(8)} ${r.sourcePath || '(inline)'}`));
            for (const b of (r.blockers || []).slice(0, 3)) console.log('    × ' + b.detectorId + ': ' + b.sample);
            for (const w of (r.warnings || []).slice(0, 3)) console.log('    ⚠ ' + w.detectorId + ': ' + w.sample);
          }
          console.log('');
        } else {
          printScanHuman(result);
        }

        const aggregate = result.summary ? result.summary.aggregateDecision : result.decision;
        if (opts.exitOnBlock && aggregate === 'block') process.exitCode = 2;
      } catch (err) {
        console.error(chalk.red(`security egress-scan error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('health')
    .description('Operator security health rollup — 7-axis red/amber/green with trend arrows vs prior run. Append --append to record the run in the health-history ledger so the next call has trend data.')
    .option('--project <id>', 'Project namespace for live decay snapshot', 'recall-dev')
    .option('--window-hours <n>', 'Lookback window for activity axes', '24')
    .option('--decay-warn-frac <n>', 'Archive-candidate fraction below which decay axis stays green', '0.10')
    .option('--append', 'Append this run to the health-history ledger so future runs show trend arrows')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const cfg = cliConfig.read();
        const dataDirPath = cliConfig.getDataDir();
        let store = null;
        try { store = meridian.init(dataDirPath, { llm: cfg.llm }); } catch (_) { /* degrade gracefully */ }
        const h = computeHealth({
          dataDir: dataDirPath,
          project: opts.project,
          windowHours: Number(opts.windowHours),
          decayWarnFrac: Number(opts.decayWarnFrac),
          store,
        });

        if (opts.append) {
          try { appendHealthLedger(h, { dataDir: dataDirPath }); } catch (_) { /* best-effort */ }
        }

        if (opts.json) {
          console.log(JSON.stringify(h, null, 2));
          if (h.overallStatus === 'red') process.exitCode = 2;
          return;
        }

        const colour = h.overallStatus === 'red' ? chalk.red
                     : h.overallStatus === 'yellow' ? chalk.yellow
                     : h.overallStatus === 'green' ? chalk.green
                     : chalk.gray;
        console.log('');
        console.log(colour.bold('━━━ Recall Security Health: ' + h.overallStatus.toUpperCase() + ' ━━━'));
        console.log(`Generated:   ${h.generatedAt}`);
        console.log(`Project:     ${h.project}  (window: last ${h.windowHours}h)`);
        console.log('');
        const dot = (status) => status === 'green' ? chalk.green('●') : status === 'yellow' ? chalk.yellow('●') : status === 'red' ? chalk.red('●') : chalk.gray('●');
        for (const a of h.axes) {
          const trendStr = a.trend || ' ';
          const valueStr = String(a.value).padEnd(28);
          console.log(`  ${dot(a.status)} ${a.name.padEnd(10)} ${trendStr}  ${valueStr}  ${chalk.gray(a.reason)}`);
        }
        if (h.issues.length > 0) {
          console.log('');
          console.log(chalk.bold('Open issues (' + h.issues.length + '):'));
          for (const i of h.issues) console.log('  • ' + i);
        }
        console.log('');
        if (h.overallStatus === 'red') process.exitCode = 2;
      } catch (err) {
        console.error(chalk.red(`security health error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('health-history')
    .description('List recent health-rollup ledger entries (most recent last). Read-only.')
    .option('--limit <n>', 'Max entries', '20')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const entries = listHealthRuns({ dataDir: cliConfig.getDataDir() });
        const slice = entries.slice(-Number(opts.limit));
        if (opts.json) { console.log(JSON.stringify({ count: slice.length, entries: slice }, null, 2)); return; }
        if (slice.length === 0) { console.log(chalk.gray('No health-history entries. Run: recall security health --append')); return; }
        console.log('');
        console.log(chalk.bold('Health History (' + slice.length + ')'));
        for (const e of slice) {
          const c = e.overallStatus === 'red' ? chalk.red : e.overallStatus === 'yellow' ? chalk.yellow : e.overallStatus === 'green' ? chalk.green : chalk.gray;
          console.log(`  #${String(e.sequence).padStart(4, ' ')}  ${c(e.overallStatus.padEnd(8))}  ${e.generatedAt}  ${e.project}`);
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red(`security health-history error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('synthesize')
    .description('Build a synthesis entry from a set of related KB entries + optional reflection. Synthesis types: confluence | contradiction | abstraction | extraction | retire-recommendation. Appends to hash-chained synthesis ledger; does NOT auto-write to the KB (operator stages via recall add).')
    .requiredOption('--type <kind>', 'confluence | contradiction | abstraction | extraction | retire-recommendation')
    .requiredOption('--name <text>', 'Name for the synthesis entry')
    .requiredOption('--project <id>', 'Target KB project')
    .requiredOption('--sources <json>', 'Source array JSON, e.g. \'[{"id":"lesson-a","project":"p","name":"...","confidence":0.9}, ...]\'')
    .option('--category <name>', 'KB category for the synthesis entry', 'lessons')
    .option('--reflection <json>', 'Optional reflection JSON ({merged:{rootCause}, agreement:{rootCauseConsensus}})')
    .option('--specialist <id>', 'Specialist id that triggered the synthesis (optional)')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const sources = JSON.parse(opts.sources);
        const reflection = opts.reflection ? JSON.parse(opts.reflection) : null;
        const r = buildSynthesis({
          sources, synthesisType: opts.type, name: opts.name, project: opts.project,
          category: opts.category, reflection, specialistId: opts.specialist || null,
        });
        const ledger = appendSynthesisLedger(r, { dataDir: cliConfig.getDataDir() });
        if (opts.json) {
          console.log(JSON.stringify({ ...r, ledger }, null, 2));
          return;
        }
        console.log('');
        console.log(chalk.green.bold('Synthesis Created: ' + r.synthesisEntry.id));
        console.log(`Type:               ${r.synthesisEntry.synthesisType}`);
        console.log(`Name:               ${r.synthesisEntry.name}`);
        console.log(`Project:            ${r.synthesisEntry.project}`);
        console.log(`Category:           ${r.synthesisEntry.category}`);
        console.log(`Confidence:         ${r.synthesisEntry.confidence}`);
        console.log(`Source citations:   ${r.citationRelationships.length}  (type=${r.citationRelationships[0] && r.citationRelationships[0].type})`);
        console.log(`Ledger entry:       #${ledger.sequence}`);
        console.log('');
        console.log(chalk.gray('Synthesis description:'));
        console.log(chalk.gray(r.synthesisEntry.description.split('\n').map((l) => '  ' + l).join('\n')));
        console.log('');
        console.log(chalk.gray('Next step: stage into KB via `recall add ' + opts.project + '` using the synthesisEntry above.'));
        console.log('');
      } catch (err) {
        console.error(chalk.red(`security synthesize error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('synthesis-list')
    .description('List recent synthesis ledger entries (most recent last). Read-only.')
    .option('--project <id>', 'Filter by project')
    .option('--limit <n>', 'Max entries', '20')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const entries = listSyntheses({ dataDir: cliConfig.getDataDir(), project: opts.project });
        const slice = entries.slice(-Number(opts.limit));
        if (opts.json) { console.log(JSON.stringify({ count: slice.length, entries: slice }, null, 2)); return; }
        if (slice.length === 0) { console.log(chalk.gray('No syntheses recorded. Run: recall security synthesize ...')); return; }
        console.log('');
        console.log(chalk.bold('Synthesis Ledger (' + slice.length + ')'));
        for (const e of slice) {
          console.log(`  #${String(e.sequence).padStart(4, ' ')}  ${e.synthesisId}  type=${e.synthesisType.padEnd(22)} conf=${e.confidence}  ${e.project}/${e.name}`);
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red(`security synthesis-list error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('synthesis-verify')
    .description('Verify the synthesis ledger hash chain.')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const r = verifySynthesisLedger({ dataDir: cliConfig.getDataDir() });
        if (opts.json) console.log(JSON.stringify(r, null, 2));
        else if (r.ok) console.log(chalk.green(`Synthesis ledger OK — ${r.entries || 0} entries`));
        else console.log(chalk.red(`Synthesis ledger TAMPERED — failed at #${r.failedAt}, reason: ${r.reason}`));
        if (!r.ok) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(`security synthesis-verify error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('health-verify')
    .description('Verify the health-history ledger hash chain.')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const r = verifyHealthLedger({ dataDir: cliConfig.getDataDir() });
        if (opts.json) console.log(JSON.stringify(r, null, 2));
        else if (r.ok) console.log(chalk.green(`Health-history ledger OK — ${r.entries || 0} entries`));
        else console.log(chalk.red(`Health-history ledger TAMPERED — failed at #${r.failedAt}, reason: ${r.reason}`));
        if (!r.ok) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(`security health-verify error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('ledger-list')
    .description('List recent egress scan ledger entries (most recent last). Read-only.')
    .option('--limit <n>', 'Max entries to print', '20')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const entries = listScans({ dataDir: dataDir(), limit: Number(opts.limit) });
        if (opts.json) {
          console.log(JSON.stringify({ count: entries.length, entries }, null, 2));
          return;
        }
        if (entries.length === 0) {
          console.log(chalk.gray('Egress scan ledger is empty.'));
          return;
        }
        console.log(chalk.bold('Egress Scan Ledger (last ' + entries.length + ')'));
        for (const e of entries) {
          const colour = e.decision === 'block' ? chalk.red : (e.decision === 'review' ? chalk.yellow : chalk.green);
          console.log(`#${String(e.sequence).padStart(4, ' ')}  ${colour(e.decision.padEnd(6))}  ${e.scannedAt}  ${e.kind}  ${e.target || '-'}  ${e.sourcePath || '-'}`);
          if (e.blockerIds && e.blockerIds.length) console.log('       blockers: ' + e.blockerIds.join(', '));
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red(`security ledger-list error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('ledger-verify')
    .description('Verify the egress scan ledger hash chain. Read-only.')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const result = verifyLedger({ dataDir: dataDir() });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.ok) {
          console.log(chalk.green(`Ledger OK — ${result.entries || 0} entries, head ${result.headHash || '(empty)'}`));
        } else {
          console.log(chalk.red(`Ledger TAMPERED — failed at sequence ${result.failedAt}, reason: ${result.reason}`));
        }
        if (!result.ok) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(`security ledger-verify error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  // -------------------------------------------------------------------
  // Graph anchors — recovery primitive (Slice #3 of OpenClaw security
  // brainstorm). Periodic signed root hash of trusted KB + manifests +
  // specialists + ledger heads, with verify + drift detection.
  // -------------------------------------------------------------------

  command
    .command('anchor-create')
    .description('Compute a signed root hash of the current KB + manifests + specialists + ledger heads, append to the anchor ledger. Hashes only, no raw content.')
    .option('--label <text>', 'Optional human-readable label (e.g. "pre-mirror-publish 0.3.0")', '')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const cfg = cliConfig.read();
        const store = meridian.init(cliConfig.getDataDir(), { llm: cfg.llm });
        const inputs = buildSnapshotInputs(store, { dataDir: cliConfig.getDataDir() });
        const result = createAnchor(inputs, { dataDir: cliConfig.getDataDir(), label: opts.label || null });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log('');
        console.log(chalk.green.bold('Graph Anchor Created'));
        console.log(`Anchor ID:   ${result.entry.anchorId}`);
        console.log(`Sequence:    ${result.entry.sequence}`);
        console.log(`Root hash:   ${result.entry.rootHash}`);
        console.log(`Signature:   ${result.entry.signature}`);
        console.log(`Created at:  ${result.entry.createdAt}`);
        if (result.entry.label) console.log(`Label:       ${result.entry.label}`);
        console.log(`Counts:      entries=${result.entry.counts.entries}  manifests=${result.entry.counts.manifests}  specialists=${result.entry.counts.specialists}  ledgerHeads=${result.entry.counts.ledgerHeads}`);
        if (result.driftSummary) {
          console.log('');
          console.log(chalk.gray('Drift vs previous anchor:'));
          console.log(`  Root changed:        ${result.driftSummary.rootChanged ? 'yes' : 'no'}`);
          console.log(`  Surfaces changed:    ${result.driftSummary.subRootsChanged.join(', ') || '(none)'}`);
          const d = result.driftSummary.countDeltas;
          console.log(`  Δ counts:            entries${signed(d.entries)} manifests${signed(d.manifests)} specialists${signed(d.specialists)} ledgers${signed(d.ledgerHeads)}`);
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red(`security anchor-create error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('anchor-list')
    .description('List recent graph anchors (most recent last). Read-only.')
    .option('--limit <n>', 'Max anchors to print', '20')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const entries = listAnchors({ dataDir: cliConfig.getDataDir(), limit: Number(opts.limit) });
        if (opts.json) {
          console.log(JSON.stringify({ count: entries.length, entries }, null, 2));
          return;
        }
        if (entries.length === 0) {
          console.log(chalk.gray('No graph anchors yet. Create one with: recall security anchor-create'));
          return;
        }
        console.log('');
        console.log(chalk.bold('Graph Anchors (last ' + entries.length + ')'));
        for (const e of entries) {
          console.log(`#${String(e.sequence).padStart(4, ' ')}  ${e.anchorId}  ${e.createdAt}  E=${e.counts.entries} M=${e.counts.manifests} S=${e.counts.specialists}  ${e.label || ''}`);
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red(`security anchor-list error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('anchor-verify')
    .description('Verify the current KB graph against a stored anchor. Without --anchor-id, verifies against the most recent anchor. Read-only.')
    .option('--anchor-id <id>', 'Anchor id to verify against (default: most recent)', '')
    .option('--chain', 'Also verify the anchor ledger hash chain itself (tamper detection on the ledger file)')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const dataDirPath = cliConfig.getDataDir();
        if (opts.chain) {
          const chain = verifyLedgerChain({ dataDir: dataDirPath });
          if (opts.json) console.log(JSON.stringify(chain, null, 2));
          else if (chain.ok) console.log(chalk.green(`Anchor ledger chain OK — ${chain.entries || 0} entries, head ${chain.headHash || '(empty)'}`));
          else console.log(chalk.red(`Anchor ledger TAMPERED — failed at #${chain.failedAt}, reason: ${chain.reason}`));
          if (!chain.ok) { process.exitCode = 1; return; }
          if (!opts.anchorId) return;
        }

        const anchors = listAnchors({ dataDir: dataDirPath });
        if (anchors.length === 0) {
          console.log(chalk.yellow('No anchors to verify against. Create one first: recall security anchor-create'));
          return;
        }
        const anchor = opts.anchorId
          ? getAnchor(opts.anchorId, { dataDir: dataDirPath })
          : anchors[anchors.length - 1];
        if (!anchor) {
          console.error(chalk.red(`Anchor not found: ${opts.anchorId}`));
          process.exitCode = 1;
          return;
        }

        const cfg = cliConfig.read();
        const store = meridian.init(dataDirPath, { llm: cfg.llm });
        const inputs = buildSnapshotInputs(store, { dataDir: dataDirPath });
        const result = verifyAgainstAnchor(inputs, anchor, { dataDir: dataDirPath });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.ok) {
          console.log('');
          console.log(chalk.green.bold(`Graph Verified Against Anchor ${result.anchorId}`));
          console.log(`Root hash:           ${result.currentRootHash}`);
          console.log(`Signature:           ${chalk.green('valid')}`);
          console.log('');
        } else {
          console.log('');
          console.log(chalk.red.bold(`Graph DRIFT vs Anchor ${result.anchorId}`));
          console.log(`Anchor root:         ${result.anchorRootHash}`);
          console.log(`Current root:        ${result.currentRootHash}`);
          console.log(`Signature valid:     ${result.signatureValid ? 'yes' : chalk.red('NO — anchor key mismatch or anchor forged')}`);
          if (result.drift) {
            console.log(`Surfaces changed:    ${result.drift.subRootsChanged.join(', ') || '(none)'}`);
            const d = result.drift.countDeltas;
            console.log(`Δ counts:            entries${signed(d.entries)} manifests${signed(d.manifests)} specialists${signed(d.specialists)} ledgers${signed(d.ledgerHeads)}`);
          }
          console.log('');
          process.exitCode = 1;
        }
      } catch (err) {
        console.error(chalk.red(`security anchor-verify error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  // -------------------------------------------------------------------
  // Vector Promotion Gate — Slice #5 of OpenClaw security brainstorm.
  // Multi-objective constraint-based promotion decision.
  // -------------------------------------------------------------------
  command
    .command('promotion-eval')
    .description('Evaluate a proposed defense/policy promotion against constraint-based gate. Inputs: --before/--after JSON files (or --before-json / --after-json inline). Returns promote / block / requires_approval.')
    .option('--before <path>', 'Path to JSON file with the before-state metric vector')
    .option('--after <path>', 'Path to JSON file with the after-state metric vector')
    .option('--before-json <text>', 'Inline JSON string for the before-state vector')
    .option('--after-json <text>', 'Inline JSON string for the after-state vector')
    .option('--touches-external-authority', 'Flag this promotion as changing external posting / tool authority (requires human approval)')
    .option('--touches-live-write', 'Flag this promotion as touching the live-write surface (NEVER auto-promotes; kernel invariant)')
    .option('--human-approval-granted', 'Operator has explicitly approved (only meaningful with --touches-external-authority)')
    .option('--fp-max <n>', 'Override falsePositiveRate maximum (default 0.05)')
    .option('--regression-rel-max <n>', 'Override max relative regression on any metric (default 0.20)')
    .option('--egress-abs-max <n>', 'Override max absolute increase in egressRisk (default 0)')
    .option('--json', 'Print full result as JSON')
    .action((opts) => {
      try {
        const loadVec = (file, inline) => {
          if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
          if (inline) return JSON.parse(inline);
          return {};
        };
        const before = loadVec(opts.before, opts.beforeJson);
        const after = loadVec(opts.after, opts.afterJson);

        const thresholds = {};
        if (opts.fpMax) thresholds.falsePositiveRateMax = Number(opts.fpMax);
        if (opts.regressionRelMax) thresholds.regressionRelMax = Number(opts.regressionRelMax);
        if (opts.egressAbsMax) thresholds.egressRiskAbsMax = Number(opts.egressAbsMax);

        const result = evaluatePromotion({
          before,
          after,
          context: {
            touchesExternalAuthority: Boolean(opts.touchesExternalAuthority),
            touchesLiveWrite: Boolean(opts.touchesLiveWrite),
            humanApprovalGranted: Boolean(opts.humanApprovalGranted),
            thresholds: Object.keys(thresholds).length > 0 ? thresholds : undefined,
          },
        });

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const colour = result.decision === 'promote' ? chalk.green : (result.decision === 'requires_approval' ? chalk.yellow : chalk.red);
          console.log('');
          console.log(colour.bold('Promotion Gate: ' + result.decision.toUpperCase()));
          console.log('Reason: ' + result.reason);
          console.log('');
          console.log(chalk.bold('Constraints:'));
          for (const c of result.constraints) {
            const mark = c.satisfied ? chalk.green('✓') : chalk.red('✗');
            console.log(`  ${mark} ${c.name}: ${c.detail}`);
          }
          if (result.improvements.length) {
            console.log('');
            console.log(chalk.cyan.bold('Improvements:'));
            for (const i of result.improvements) {
              console.log(`  + ${i.axis}: ${i.before} → ${i.after}`);
            }
          }
          if (result.regressions.length) {
            console.log('');
            console.log(chalk.red.bold('Regressions:'));
            for (const r of result.regressions) {
              console.log(`  - ${r.axis}: ${r.before} → ${r.after}  (Δrel=${r.relChange.toFixed(3)})`);
            }
          }
          console.log('');
        }
        if (result.decision === 'block') process.exitCode = 2;
      } catch (err) {
        console.error(chalk.red(`security promotion-eval error: ${err.message}`));
        process.exitCode = 1;
      }
    });
};

function signed(n) {
  if (n > 0) return chalk.cyan('+' + n);
  if (n < 0) return chalk.red(String(n));
  return ' 0';
}

// Dream cycle CLI is registered as a separate function attached to
// the same `command` parent — pulled out for readability since the
// surface is cohesive (dream-run / dream-list / dream-verify).
module.exports.attachDreamCycleCommands = function attachDreamCycleCommands(parent) {
  parent
    .command('dream-run')
    .description('Run the nightly Dream Cycle (Slice #4): walk reconsolidation + basin + anchor drift + denied-egress + hard-cases over the last N hours, synthesize human-review proposals, append to dream-cycle ledger. Never auto-promotes.')
    .option('--project <id>', 'Project to scope to', 'recall-dev')
    .option('--window-hours <n>', 'Lookback window in hours', '24')
    .option('--reflect-specialist <id>', 'Also draft closed-loop reflection/proposal items for a specialist; never promotes')
    .option('--schedule <label>', 'Scheduling stub label, e.g. nightly')
    .option('--no-ledger', 'Do not append the run to the ledger')
    .option('--json', 'Print run as JSON')
    .action((opts) => {
      try {
        const cfg = cliConfig.read();
        const dataDirPath = cliConfig.getDataDir();
        const store = meridian.init(dataDirPath, { llm: cfg.llm });
        const collectors = buildLiveCollectors({ store, dataDir: dataDirPath, project: opts.project });
        const result = runDreamCycle(collectors, {
          dataDir: dataDirPath,
          project: opts.project,
          windowHours: Number(opts.windowHours),
          appendToLedger: opts.ledger !== false,
        });
        if (opts.reflectSpecialist) {
          result.closedLoopReflection = closedLoop.buildDreamReflectionProposal(store, {
            project: opts.project,
            specialistId: opts.reflectSpecialist,
          });
        }
        if (opts.schedule) {
          result.scheduleStub = { requested: opts.schedule, status: 'stub_only_no_automation_created' };
        }
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log('');
        console.log(chalk.bold('Dream Cycle: ' + result.runId));
        console.log(`Project:      ${result.project}`);
        console.log(`Window:       last ${result.windowHours}h`);
        console.log(`Duration:     ${result.durationMs}ms`);
        console.log('');
        console.log(chalk.bold('Surveys:'));
        for (const [k, v] of Object.entries(result.surveys)) {
          if (v.error) console.log(`  ${k}: ${chalk.yellow('error: ' + v.error)}`);
          else if (v.skipped) console.log(`  ${k}: ${chalk.gray('skipped: ' + v.skipped)}`);
          else if (typeof v.count === 'number') console.log(`  ${k}: count=${v.count}`);
          else console.log(`  ${k}: ${JSON.stringify(v).slice(0, 80)}`);
        }
        console.log('');
        if (result.proposals.length === 0) {
          console.log(chalk.green('No proposals — quiet night.'));
        } else {
          console.log(chalk.bold(`Proposals (${result.proposals.length}, all require human review):`));
          for (const p of result.proposals) {
            console.log(`  • [${p.kind}] ${p.summary}`);
          }
        }
        if (result.closedLoopReflection) {
          console.log('');
          console.log(chalk.bold(`Closed-loop reflection drafts (${result.closedLoopReflection.proposals.length}):`));
          for (const p of result.closedLoopReflection.proposals) {
            console.log(`  - ${p.basinId}: ${p.proposal.summary}`);
          }
        }
        if (result.scheduleStub) {
          console.log('');
          console.log(chalk.gray(`Schedule stub: ${result.scheduleStub.requested} (${result.scheduleStub.status})`));
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red(`security dream-run error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('dream-list')
    .description('List recent dream cycle runs from the ledger.')
    .option('--limit <n>', 'Max runs to print', '20')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const entries = listDreamRuns({ dataDir: cliConfig.getDataDir() });
        const slice = entries.slice(-Number(opts.limit));
        if (opts.json) {
          console.log(JSON.stringify({ count: slice.length, entries: slice }, null, 2));
          return;
        }
        if (slice.length === 0) {
          console.log(chalk.gray('No dream runs yet. Run with: recall security dream-run'));
          return;
        }
        console.log('');
        console.log(chalk.bold('Dream Runs (last ' + slice.length + ')'));
        for (const e of slice) {
          const summary = e.surveysSummary || {};
          console.log(`#${String(e.sequence).padStart(4, ' ')}  ${e.runId}  ${e.startedAt}  ${e.project}  proposals=${e.proposalCount}  drift=${summary.anchorDrift ? 'YES' : 'no'}`);
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red(`security dream-list error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('ensemble-eval')
    .description('Cross-system evaluator ensemble: composes a rules evaluator + a local heuristic + (optionally) an LLM evaluator. Returns agree-allow / agree-block / agree-review / agree-*-by-majority / disagree-needs-human.')
    .option('--content <text>', 'Inline content to evaluate (mutually exclusive with --file/--subject)')
    .option('--file <path>', 'Read subject content from a file')
    .option('--subject <path>', 'Path to a JSON file with the full subject shape ({content, blockers, warnings, egressTarget, hasSecrets, hasPrivatePath})')
    .option('--egress-target <kind>', 'Mark this content as outbound to <kind> (e.g. moltbook:public, github:public-mirror)', '')
    .option('--with-llm', 'Include the openclaw-governor specialist as the frontier-model evaluator (requires ANTHROPIC_API_KEY in env or LLM config)')
    .option('--json', 'Print full ensemble result as JSON')
    .action((opts) => {
      try {
        let subject;
        if (opts.subject) {
          subject = JSON.parse(fs.readFileSync(opts.subject, 'utf8'));
        } else if (opts.file) {
          subject = { content: fs.readFileSync(opts.file, 'utf8') };
        } else if (opts.content) {
          subject = { content: opts.content };
        } else {
          throw new Error('Provide one of --content / --file / --subject');
        }
        if (opts.egressTarget && !subject.egressTarget) subject.egressTarget = opts.egressTarget;

        // Pre-feed the rules evaluator with the egress-scanner result
        // so it has structured blockers/warnings to reason over.
        if (subject.content && (!subject.blockers || !subject.warnings)) {
          const scan = scanContent({ content: subject.content, kind: 'inline', target: subject.egressTarget || null });
          subject.blockers = subject.blockers || scan.blockers;
          subject.warnings = subject.warnings || scan.warnings;
          subject.scanDecision = scan.decision;
        }

        const evaluators = [rulesEvaluator(), heuristicEvaluator()];

        if (opts.withLlm) {
          // Wrap the openclaw-governor specialist as the frontier-model
          // evaluator. Best-effort — falls back to a clearly-labeled
          // skip if the LLM port isn't configured.
          try {
            const cfg = cliConfig.read();
            const store = meridian.init(cliConfig.getDataDir(), { llm: cfg.llm });
            evaluators.push(llmEvaluator({
              name: 'openclaw-governor',
              invoke: () => {
                // Synchronous degraded version: invoke the underlying
                // LLM via the IL specialist runner, returning a decision.
                // For brevity, this just returns 'review' with low
                // confidence — the proper async wiring lands in the
                // next iteration.
                return { decision: 'review', confidence: 0.3, rationale: 'LLM evaluator stub (sync path) — full wiring queued' };
              },
            }));
          } catch (err) {
            console.error(chalk.yellow(`(--with-llm requested but LLM port unavailable: ${err.message}; continuing with rules+heuristic only)`));
          }
        }

        const result = evaluateEnsemble({ subject, evaluators });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const colour = result.decision.startsWith('agree-block') ? chalk.red
                     : result.decision.startsWith('disagree') ? chalk.yellow
                     : result.decision.includes('block') ? chalk.red
                     : chalk.green;
        console.log('');
        console.log(colour.bold('Ensemble: ' + result.decision.toUpperCase()));
        console.log('Reason: ' + result.reason);
        console.log('');
        console.log(chalk.bold('Verdicts:'));
        for (const v of result.verdicts) {
          const c = v.decision === 'block' ? chalk.red : (v.decision === 'review' ? chalk.yellow : chalk.green);
          console.log(`  ${c(v.decision.padEnd(7))} [${v.kind}] ${v.name}  conf=${v.confidence != null ? v.confidence.toFixed(2) : '?'}`);
          console.log(`           ${chalk.gray(v.rationale)}`);
        }
        if (result.agreement.conflicts.length) {
          console.log('');
          console.log(chalk.yellow.bold('Conflicts:'));
          for (const c of result.agreement.conflicts) {
            console.log(`  ${c.a} vs ${c.b}: ${c.decisions.join(' vs ')}`);
          }
        }
        console.log('');
        if (result.decision === 'disagree-needs-human' || result.decision === 'agree-block') {
          process.exitCode = 2;
        }
      } catch (err) {
        console.error(chalk.red(`security ensemble-eval error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('arch-review-queue')
    .description('Queue an item for HUMAN architect review (non-LLM). Use for high-stakes decisions (live-write authority, kernel invariant changes, anchor key rotation). LLM-shaped names are refused at sign time — correlated-failure mitigation per §14.')
    .requiredOption('--title <text>', 'Short title')
    .requiredOption('--surfaces <list>', 'Comma-separated surfaces touched (e.g. live-write,promotion-gate)')
    .requiredOption('--risk <level>', 'low | medium | high | critical')
    .option('--evidence <list>', 'Comma-separated evidence ids')
    .option('--sla-days <n>', 'Review SLA in days', '7')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const r = archReview.queueItem({
          title: opts.title,
          surfaces: opts.surfaces.split(',').map((s) => s.trim()).filter(Boolean),
          riskLevel: opts.risk,
          evidence: opts.evidence ? opts.evidence.split(',').map((s) => s.trim()).filter(Boolean) : [],
          slaDays: Number(opts.slaDays),
        }, { dataDir: cliConfig.getDataDir() });
        if (opts.json) console.log(JSON.stringify(r, null, 2));
        else {
          console.log(chalk.yellow.bold(`Queued for human architect review: ${r.itemId}`));
          console.log(`  due:     ${r.dueAt}`);
          console.log(`  risk:    ${r.riskLevel}`);
          console.log(chalk.gray(`  Sign with: recall security arch-review-sign --item-id ${r.itemId} --human-name "<your name>" --decision approve|reject --rationale "..."`));
        }
      } catch (err) {
        console.error(chalk.red(`security arch-review-queue error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('arch-review-list')
    .description('List items in the architect review queue.')
    .option('--status <s>', 'Filter: queued | overdue | signed-approve | signed-reject')
    .option('--overdue', 'Only show overdue items')
    .option('--limit <n>', 'Max items to print', '20')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const items = archReview.listItems({ dataDir: cliConfig.getDataDir(), status: opts.status, overdue: opts.overdue, limit: Number(opts.limit) });
        if (opts.json) {
          console.log(JSON.stringify({ count: items.length, items }, null, 2));
          return;
        }
        if (items.length === 0) { console.log(chalk.gray('No architect-review items.')); return; }
        console.log('');
        console.log(chalk.bold('Architect Review Queue (' + items.length + ')'));
        for (const it of items) {
          const sc = it.status === 'overdue' ? chalk.red : (it.status === 'queued' ? chalk.yellow : (it.status === 'signed-approve' ? chalk.green : chalk.red));
          console.log(`  ${sc(it.status.padEnd(15))} ${it.itemId}  due=${it.dueAt}  risk=${it.riskLevel}`);
          console.log(`    ${chalk.bold(it.title)}`);
          if (it.humanName) console.log(`    signed-by ${it.humanName} @ ${it.signedAt}: ${it.decision}`);
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red(`security arch-review-list error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('arch-review-sign')
    .description('Sign an architect-review item with human name + decision + rationale. LLM-shaped names are refused.')
    .requiredOption('--item-id <id>', 'Item id from arch-review-queue')
    .requiredOption('--human-name <name>', 'Real human name (NOT an LLM identifier)')
    .requiredOption('--decision <d>', 'approve | reject')
    .requiredOption('--rationale <text>', 'Why this decision')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const e = archReview.signItem(opts.itemId, { humanName: opts.humanName, decision: opts.decision, rationale: opts.rationale }, { dataDir: cliConfig.getDataDir() });
        if (opts.json) console.log(JSON.stringify(e, null, 2));
        else {
          const colour = opts.decision === 'approve' ? chalk.green : chalk.red;
          console.log(colour(`Signed ${opts.itemId}: ${opts.decision} by ${opts.humanName}`));
        }
      } catch (err) {
        console.error(chalk.red(`security arch-review-sign error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('arch-review-verify')
    .description('Verify the architect-review ledger hash chain.')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const r = archReview.verifyQueueLedger({ dataDir: cliConfig.getDataDir() });
        if (opts.json) console.log(JSON.stringify(r, null, 2));
        else if (r.ok) console.log(chalk.green(`Architect-review ledger OK — ${r.entries || 0} entries`));
        else console.log(chalk.red(`Architect-review ledger TAMPERED — failed at #${r.failedAt}, reason: ${r.reason}`));
        if (!r.ok) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(`security arch-review-verify error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('sbom')
    .description('Generate a Software Bill of Materials for a Node.js project: every direct + transitive dependency with version + integrity hash. Output is signed (sbomHash). Audit ledger entry per generation.')
    .option('--root <path>', 'Project root containing package.json + package-lock.json (default: cwd)', process.cwd())
    .option('--json', 'Print full SBOM as JSON (default: summary only)')
    .action((opts) => {
      try {
        const pkgPath = path.join(opts.root, 'package.json');
        const lockPath = path.join(opts.root, 'package-lock.json');
        if (!fs.existsSync(pkgPath)) throw new Error(`package.json not found at ${pkgPath}`);
        const packageJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const lockfile = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : null;
        const sbom = buildSbom({ packageJson, lockfile });
        if (opts.json) {
          console.log(JSON.stringify(sbom, null, 2));
          return;
        }
        console.log('');
        console.log(chalk.bold(`SBOM — ${sbom.name}@${sbom.version}`));
        console.log(`Generated:        ${sbom.generatedAt}`);
        console.log(`SBOM hash:        ${sbom.sbomHash}`);
        console.log('');
        console.log(`Declared direct:  ${sbom.summary.declaredDirect}`);
        console.log(`Declared dev:     ${sbom.summary.declaredDev}`);
        console.log(`Declared peer:    ${sbom.summary.declaredPeer}`);
        console.log(`Resolved total:   ${sbom.summary.resolvedTotal}`);
        console.log(`With integrity:   ${chalk.green(sbom.summary.withIntegrity)}`);
        const w = sbom.summary.withoutIntegrity;
        console.log(`Without integrity: ${w > 0 ? chalk.red(w) : chalk.green(0)}`);
        console.log(`From npm registry: ${chalk.green(sbom.summary.fromRegistry)}`);
        const o = sbom.summary.fromOtherSource;
        console.log(`From other source: ${o > 0 ? chalk.yellow(o) : chalk.green(0)}`);
        console.log('');
      } catch (err) {
        console.error(chalk.red(`security sbom error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('lockfile-verify')
    .description('Verify package.json and package-lock.json are aligned. Catches drift between manifest and lockfile that would let `npm install` resolve different code than the operator audited.')
    .option('--root <path>', 'Project root', process.cwd())
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const pkgPath = path.join(opts.root, 'package.json');
        const lockPath = path.join(opts.root, 'package-lock.json');
        if (!fs.existsSync(pkgPath)) throw new Error(`package.json not found at ${pkgPath}`);
        if (!fs.existsSync(lockPath)) throw new Error(`package-lock.json not found at ${lockPath}`);
        const packageJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const lockfile = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        const r = verifyLockfile({ packageJson, lockfile });
        if (opts.json) {
          console.log(JSON.stringify(r, null, 2));
          if (!r.ok) process.exitCode = 2;
          return;
        }
        console.log('');
        if (r.ok) {
          console.log(chalk.green.bold(`Lockfile aligned — ${r.declaredCount} declared, ${r.resolvedTopLevel} resolved at top level`));
        } else {
          console.log(chalk.red.bold(`Lockfile DRIFT — ${r.drifts.length} mismatch(es)`));
          for (const d of r.drifts.slice(0, 20)) {
            console.log(`  ${chalk.red(d.kind)}  ${d.name}: ${d.detail}`);
          }
          process.exitCode = 2;
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red(`security lockfile-verify error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('dep-audit')
    .description('Audit dependency shapes: missing integrity hashes, non-registry sources (git/file/http), supply-chain attack surface.')
    .option('--root <path>', 'Project root', process.cwd())
    .option('--allow-source <list>', 'Comma-separated allowed source URL prefixes (default: https://registry.npmjs.org/)', 'https://registry.npmjs.org/')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const lockPath = path.join(opts.root, 'package-lock.json');
        if (!fs.existsSync(lockPath)) throw new Error(`package-lock.json not found at ${lockPath}`);
        const lockfile = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        const allowSources = opts.allowSource.split(',').map((s) => s.trim()).filter(Boolean);
        const r = auditDependencyShapes({ lockfile, allowSources });
        if (opts.json) {
          console.log(JSON.stringify(r, null, 2));
          if (r.summary.bySeverity.high > 0) process.exitCode = 2;
          return;
        }
        console.log('');
        const colour = r.summary.bySeverity.high > 0 ? chalk.red : (r.summary.bySeverity.medium > 0 ? chalk.yellow : chalk.green);
        console.log(colour.bold(`Dependency Audit — ${r.summary.findings} finding(s) across ${r.summary.totalResolved} resolved packages`));
        console.log(`High:    ${r.summary.bySeverity.high}`);
        console.log(`Medium:  ${r.summary.bySeverity.medium}`);
        console.log(`Low:     ${r.summary.bySeverity.low}`);
        console.log('');
        if (r.findings.length > 0) {
          console.log(chalk.bold('Findings (first 20):'));
          for (const f of r.findings.slice(0, 20)) {
            const fc = f.severity === 'high' ? chalk.red : (f.severity === 'medium' ? chalk.yellow : chalk.gray);
            console.log(`  ${fc(f.severity.toUpperCase())} ${f.kind}: ${f.name}@${f.version}`);
            console.log(`     ${chalk.gray(f.detail)}`);
          }
          console.log('');
        }
        if (r.summary.bySeverity.high > 0) process.exitCode = 2;
      } catch (err) {
        console.error(chalk.red(`security dep-audit error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('audit-ingest')
    .description('Submit an action record from any agent (OpenClaw, Claude Code, MCP client, etc.). Records arrive UNTRUSTED by default and require explicit human approval to promote (Codex 5-slice #3).')
    .requiredOption('--agent-id <id>', 'Reporting agent identifier (e.g. "openclaw-mac")')
    .requiredOption('--action-kind <kind>', 'post | tool_call | http_request | file_write | file_read | read_kb | other')
    .option('--target <json>', 'Action target as JSON (e.g. \'{"channel":"moltbook","text":"hi"}\')', '{}')
    .option('--rationale <text>', 'Why the agent did/tried this')
    .option('--outcome <kind>', 'attempted | succeeded | blocked | errored', 'attempted')
    .option('--evidence <list>', 'Comma-separated KB entry ids the agent cited')
    .option('--content-hash <hash>', 'Optional sha256 of action content')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const record = {
          agentId: opts.agentId,
          actionKind: opts.actionKind,
          target: opts.target ? JSON.parse(opts.target) : null,
          rationale: opts.rationale || null,
          outcome: opts.outcome,
          evidence: opts.evidence ? opts.evidence.split(',').map((s) => s.trim()).filter(Boolean) : [],
          contentHash: opts.contentHash || null,
        };
        const r = auditIngest.submitAuditRecord(record, { dataDir: cliConfig.getDataDir() });
        if (opts.json) console.log(JSON.stringify(r, null, 2));
        else {
          console.log(chalk.yellow(`Audit record submitted: ${r.recordId}  status=${r.entry.statusAfter}  agent=${record.agentId}  kind=${record.actionKind}`));
          console.log(chalk.gray(`  Promote with: recall security audit-promote --record-id ${r.recordId} --human-approval "<your-signature>"`));
        }
      } catch (err) {
        console.error(chalk.red(`security audit-ingest error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('audit-list')
    .description('List audit-ingest records with current status (untrusted | trusted | rejected).')
    .option('--status <s>', 'Filter by status: untrusted | trusted | rejected')
    .option('--agent-id <id>', 'Filter by agent id')
    .option('--limit <n>', 'Max records to print', '20')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const records = auditIngest.listAuditRecords({ dataDir: cliConfig.getDataDir(), status: opts.status, agentId: opts.agentId, limit: Number(opts.limit) });
        if (opts.json) {
          console.log(JSON.stringify({ count: records.length, records }, null, 2));
          return;
        }
        if (records.length === 0) { console.log(chalk.gray('No audit records.')); return; }
        console.log('');
        console.log(chalk.bold('Audit Records (last ' + records.length + ')'));
        for (const r of records) {
          const c = r.status === 'trusted' ? chalk.green : (r.status === 'rejected' ? chalk.red : chalk.yellow);
          console.log(`  ${c(r.status.padEnd(9))} ${r.recordId}  agent=${r.agentId}  kind=${r.actionKind}  events=${r.eventCount}`);
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red(`security audit-list error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('audit-promote')
    .description('Promote an untrusted audit record to trusted. Requires explicit --human-approval (kernel invariant: no auto-promotion).')
    .requiredOption('--record-id <id>', 'Record id to promote')
    .requiredOption('--human-approval <ref>', 'Human approval reference (e.g. "jesse@2026-05-13:approved")')
    .option('--evidence <list>', 'Comma-separated additional evidence ids')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const evidence = opts.evidence ? opts.evidence.split(',').map((s) => s.trim()).filter(Boolean) : null;
        const e = auditIngest.promoteAuditRecord(opts.recordId, { humanApproval: opts.humanApproval, evidence }, { dataDir: cliConfig.getDataDir() });
        if (opts.json) console.log(JSON.stringify(e, null, 2));
        else console.log(chalk.green(`Promoted ${opts.recordId} to trusted (approval: ${opts.humanApproval})`));
      } catch (err) {
        console.error(chalk.red(`security audit-promote error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('audit-reject')
    .description('Reject an audit record. Requires --reason.')
    .requiredOption('--record-id <id>', 'Record id to reject')
    .requiredOption('--reason <text>', 'Why this record is being rejected')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const e = auditIngest.rejectAuditRecord(opts.recordId, { reason: opts.reason }, { dataDir: cliConfig.getDataDir() });
        if (opts.json) console.log(JSON.stringify(e, null, 2));
        else console.log(chalk.red(`Rejected ${opts.recordId}: ${opts.reason}`));
      } catch (err) {
        console.error(chalk.red(`security audit-reject error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('audit-verify')
    .description('Verify the audit-ingest ledger hash chain.')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const r = auditIngest.verifyAuditLedger({ dataDir: cliConfig.getDataDir() });
        if (opts.json) console.log(JSON.stringify(r, null, 2));
        else if (r.ok) console.log(chalk.green(`Audit ingest ledger OK — ${r.entries || 0} entries, head ${r.headHash || '(empty)'}`));
        else console.log(chalk.red(`Audit ingest ledger TAMPERED — failed at #${r.failedAt}, reason: ${r.reason}`));
        if (!r.ok) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(`security audit-verify error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('collusion-check')
    .description('Scan recent audit records for multi-agent collusion patterns: split-leak, rate-aggregation, information-aggregation, coordinated-timing.')
    .option('--window-hours <n>', 'Lookback window', '24')
    .option('--rate-cap <n>', 'Aggregate actions/hour cap', '30')
    .option('--retriever-cap <n>', 'Max distinct retrievers per evidence id', '3')
    .option('--cv-cap <n>', 'Inter-arrival CV below this is flagged as scripted', '0.10')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const records = auditIngest.listAuditRecords({ dataDir: cliConfig.getDataDir() });
        const r = detectCollusion({
          records,
          scanContent: (a) => scanContent(a),
          windowHours: Number(opts.windowHours),
          ratePerHourCap: Number(opts.rateCap),
          distinctRetrieverCap: Number(opts.retrieverCap),
          timingCvCap: Number(opts.cvCap),
        });
        if (opts.json) {
          console.log(JSON.stringify(r, null, 2));
          if (r.findings.some((f) => f.severity === 'high')) process.exitCode = 2;
          return;
        }
        console.log('');
        const colour = r.findings.some((f) => f.severity === 'high') ? chalk.red
                     : (r.findings.length > 0 ? chalk.yellow : chalk.green);
        console.log(colour.bold(`Collusion Check: ${r.findings.length} finding(s)`));
        console.log(`Window:        last ${r.summary.windowHours}h`);
        console.log(`Records:       ${r.summary.totalRecords}`);
        console.log(`Distinct agents: ${r.summary.totalAgents}`);
        if (r.findings.length === 0) { console.log(chalk.green('  No collusion patterns detected.')); console.log(''); return; }
        console.log('');
        console.log(chalk.bold('Findings:'));
        for (const f of r.findings) {
          const fc = f.severity === 'high' ? chalk.red : chalk.yellow;
          console.log(`  ${fc(f.severity.toUpperCase())} ${f.kind}: agents=[${f.agentIds.join(', ')}]`);
          console.log(`    ${chalk.gray(f.detail)}`);
        }
        console.log('');
        if (r.findings.some((f) => f.severity === 'high')) process.exitCode = 2;
      } catch (err) {
        console.error(chalk.red(`security collusion-check error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('adversary-run')
    .description('Generate synthetic attacks (api-key leak / path leak / base64 / raw-memory / covert-encoding / credential-env / clean-control) and run them through the live defenses (egress scanner + rules evaluator). Reports catch rate per category. Appends to adversary-run-ledger.')
    .option('--count <n>', 'Number of attacks to generate', '30')
    .option('--seed <n>', 'Seed for deterministic attack generation', String(Date.now() % 1000000))
    .option('--categories <list>', 'Comma-separated subset of attack categories (default: all)')
    .option('--no-ledger', 'Skip appending to the adversary-run-ledger')
    .option('--json', 'Print full results as JSON')
    .action((opts) => {
      try {
        const cats = opts.categories ? opts.categories.split(',').map((c) => c.trim()).filter(Boolean) : null;
        const attacks = generateAttacks({
          count: Number(opts.count),
          seed: Number(opts.seed),
          categories: cats,
        });
        const defenses = [
          {
            name: 'egress-scanner',
            kind: 'rules',
            evaluate: (content) => scanContent({ content, kind: 'inline' }),
          },
          {
            name: 'recall-rules',
            kind: 'rules',
            evaluate: (content) => {
              const scan = scanContent({ content });
              return rulesEvaluator().evaluate({ blockers: scan.blockers, warnings: scan.warnings, content });
            },
          },
        ];
        const r = runAdversaryRun({ attacks, defenses, opts: { dataDir: cliConfig.getDataDir(), appendToLedger: opts.ledger !== false, seed: opts.seed } });
        if (opts.json) {
          console.log(JSON.stringify(r, null, 2));
          return;
        }
        console.log('');
        console.log(chalk.bold('Adversary Run: ' + r.runId));
        console.log(`Attacks:           ${r.summary.total}`);
        console.log(`Defenses:          ${r.summary.defenseCount}`);
        console.log(`Catch rate (any):  ${(r.summary.catchRateAny * 100).toFixed(1)}%`);
        console.log(`Catch rate (all):  ${(r.summary.catchRateAll * 100).toFixed(1)}%`);
        console.log(`Duration:          ${r.summary.durationMs}ms`);
        console.log('');
        console.log(chalk.bold('Per-category:'));
        for (const [cat, stats] of Object.entries(r.summary.categoryBreakdown)) {
          const rate = stats.total ? (stats.anyCaught / stats.total) : 0;
          const colour = rate >= 0.9 ? chalk.green : (rate >= 0.6 ? chalk.yellow : chalk.red);
          console.log(`  ${cat.padEnd(22)}  ${stats.anyCaught}/${stats.total}  ${colour((rate * 100).toFixed(0) + '%')}`);
        }
        console.log('');
        const misses = r.results.filter((x) => !x.anyMatched);
        if (misses.length > 0) {
          console.log(chalk.red.bold(`Misses (${misses.length}, first 5):`));
          for (const m of misses.slice(0, 5)) {
            console.log(`  ${m.attackId}  category=${m.category}  expected=${m.expectedDecision}  defenses said: ${m.defenses.map((d) => `${d.name}=${d.decision}`).join(', ')}`);
          }
          console.log('');
        }
      } catch (err) {
        console.error(chalk.red(`security adversary-run error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('adversary-categories')
    .description('List the synthetic attack categories the adversary engine generates.')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const cats = Object.entries(ATTACK_CATEGORIES).map(([id, def]) => ({
          id,
          expectedDecision: def.expectedDecision,
          expectedReasons: def.expectedReasons,
        }));
        if (opts.json) console.log(JSON.stringify(cats, null, 2));
        else {
          console.log('');
          console.log(chalk.bold('Adversary Attack Categories'));
          for (const c of cats) {
            console.log(`  ${c.id.padEnd(22)}  expected=${c.expectedDecision}  reasons=[${c.expectedReasons.join(', ')}]`);
          }
          console.log('');
        }
      } catch (err) {
        console.error(chalk.red(`security adversary-categories error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('negprom-record')
    .description('Record a negative-promotion event for a KB entry: it was retrieved into a reasoning context but not cited / contradicted / unused. Each event compounds a small confidence penalty.')
    .requiredOption('--entry-id <id>', 'KB entry id that was retrieved-but-not-promoted')
    .requiredOption('--reason <text>', 'retrieved-but-not-cited | retrieved-and-contradicted | retrieval-without-use | other')
    .option('--source <text>', 'What did the retrieval (e.g. specialist:codebase-reviewer, mcp:claude-desktop)', 'unknown')
    .option('--context-hash <hash>', 'Optional content hash of the consuming reasoning context (for audit linking)')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const e = recordNegativePromotion(
          { entryId: opts.entryId, source: opts.source, reason: opts.reason, contextHash: opts.contextHash || null },
          { dataDir: cliConfig.getDataDir() }
        );
        if (opts.json) console.log(JSON.stringify(e, null, 2));
        else {
          console.log(chalk.yellow(`Negative-promotion event recorded: ${e.eventId} (${e.entryId}, reason=${e.reason})`));
        }
      } catch (err) {
        console.error(chalk.red(`security negprom-record error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('negprom-summary')
    .description('Summarize accumulated negative-promotion penalty for a KB entry. Shows event count + cumulative confidence multiplier.')
    .requiredOption('--entry-id <id>', 'KB entry id')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const r = summarizePenalty(opts.entryId, { dataDir: cliConfig.getDataDir() });
        if (opts.json) {
          console.log(JSON.stringify(r, null, 2));
          return;
        }
        console.log('');
        console.log(chalk.bold('Negative-Promotion Summary'));
        console.log(`Entry:                ${r.entryId}`);
        console.log(`Total events:         ${r.totalEvents}`);
        console.log(`Cumulative penalty:   ${r.cumulativePenalty}  (multiply with base confidence)`);
        if (r.lastEvent) console.log(`Last event:           ${r.lastEvent.eventId} @ ${r.lastEvent.occurredAt} (${r.lastEvent.reason})`);
        console.log('');
      } catch (err) {
        console.error(chalk.red(`security negprom-summary error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('negprom-verify')
    .description('Verify the negative-promotion ledger hash chain.')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const r = verifyNegPromLedger({ dataDir: cliConfig.getDataDir() });
        if (opts.json) console.log(JSON.stringify(r, null, 2));
        else if (r.ok) console.log(chalk.green(`Negative-promotion ledger OK — ${r.entries || 0} entries, head ${r.headHash || '(empty)'}`));
        else console.log(chalk.red(`Negative-promotion ledger TAMPERED — failed at #${r.failedAt}, reason: ${r.reason}`));
        if (!r.ok) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(`security negprom-verify error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('dashboard')
    .description('Operator security dashboard: one-screen summary of egress scans, anchors, canaries, dream cycle, drift, decay. Read-only.')
    .option('--project <id>', 'Project namespace for live decay snapshot', 'recall-dev')
    .option('--window-hours <n>', 'Window for drift comparison + recent activity', '24')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const cfg = cliConfig.read();
        const dataDirPath = cliConfig.getDataDir();
        let store = null;
        try { store = meridian.init(dataDirPath, { llm: cfg.llm }); } catch (_) { /* dashboard degrades */ }
        const r = buildDashboard({ dataDir: dataDirPath, project: opts.project, windowHours: Number(opts.windowHours), deps: { store } });
        if (opts.json) {
          console.log(JSON.stringify(r, null, 2));
          return;
        }
        const statusColour = r.overallStatus === 'green' ? chalk.green
                           : r.overallStatus === 'yellow' ? chalk.yellow
                           : r.overallStatus === 'red' ? chalk.red
                           : chalk.gray;
        console.log('');
        console.log(statusColour.bold('━━━ Recall Security Dashboard ━━━'));
        console.log(`Generated:   ${r.generatedAt}`);
        console.log(`Project:     ${r.project}`);
        console.log(`Window:      last ${r.windowHours}h`);
        console.log(`Status:      ${statusColour.bold(r.overallStatus.toUpperCase())}`);
        console.log('');
        if (r.issues.length) {
          console.log(chalk.bold('Issues:'));
          for (const issue of r.issues) console.log('  • ' + issue);
          console.log('');
        }
        console.log(chalk.bold('Egress DLP'));
        console.log(`  total ever scanned: ${r.egress.totalEverScanned}`);
        console.log(`  last ${r.windowHours}h: ${r.egress.last.scans} scans  block=${r.egress.last.block}  review=${r.egress.last.review}  allow=${r.egress.last.allow}`);
        if (r.egress.topDetectors.length) {
          console.log('  top detectors: ' + r.egress.topDetectors.map((d) => `${d.detectorId}=${d.count}`).join(', '));
        }
        console.log('');
        console.log(chalk.bold('Graph Anchors'));
        if (r.anchor.latest) {
          console.log(`  ${r.anchor.totalAnchors} anchor(s); latest ${r.anchor.latest.anchorId} @ ${r.anchor.latest.createdAt}`);
          console.log(`  counts: entries=${r.anchor.latest.counts.entries} manifests=${r.anchor.latest.counts.manifests} specialists=${r.anchor.latest.counts.specialists}`);
        } else {
          console.log(chalk.gray('  no anchors yet — run `recall security anchor-create`'));
        }
        console.log('');
        console.log(chalk.bold('Canaries'));
        console.log(`  planted: ${r.canaries.totalPlanted}` + (r.canaries.totalPlanted ? ' across projects: ' + JSON.stringify(r.canaries.plantedByProject) : ''));
        console.log(chalk.gray('  ' + r.canaries.note));
        console.log('');
        console.log(chalk.bold('Dream Cycle'));
        if (r.dream.last) {
          console.log(`  ${r.dream.totalRuns} run(s); last ${r.dream.last.runId} @ ${r.dream.last.startedAt}`);
          console.log(`  proposals: ${r.dream.last.proposalCount}` + (r.dream.last.proposalKinds.length ? ` [${r.dream.last.proposalKinds.join(', ')}]` : ''));
        } else {
          console.log(chalk.gray('  no dream runs yet — run `recall security dream-run`'));
        }
        console.log('');
        console.log(chalk.bold('Defense Drift'));
        const driftColour = r.drift.decision === 'critical' ? chalk.red
                          : r.drift.decision === 'investigate' ? chalk.yellow
                          : r.drift.decision === 'monitor' ? chalk.cyan
                          : chalk.green;
        console.log(`  decision: ${driftColour(r.drift.decision)}` + (r.drift.driftCount != null ? `  drifts=${r.drift.driftCount}  critical=${r.drift.criticalCount}` : ''));
        if (r.drift.topDrift) console.log(`  top: ${r.drift.topDrift.severity} ${r.drift.topDrift.axis} — ${r.drift.topDrift.detail}`);
        console.log('');
        console.log(chalk.bold('Decay Status (' + (r.decay.project || '?') + ')'));
        if (r.decay.available) {
          console.log(`  total=${r.decay.total}  fresh=${r.decay.counts.fresh}  aging=${r.decay.counts.aging}  stale=${r.decay.counts.stale}  archive=${r.decay.counts.archive}`);
        } else {
          console.log(chalk.gray('  ' + (r.decay.note || r.decay.error || 'unavailable')));
        }
        console.log('');
        console.log(chalk.bold('Audit Ingest (OpenClaw contract receiver)'));
        if (r.auditIngest && r.auditIngest.available) {
          const a = r.auditIngest;
          console.log(`  total records: ${a.totalRecords}  untrusted=${chalk.yellow(a.byStatus.untrusted)}  trusted=${chalk.green(a.byStatus.trusted)}  rejected=${chalk.red(a.byStatus.rejected)}  agents=${a.distinctAgents}`);
        } else {
          console.log(chalk.gray('  no audit records yet'));
        }
        console.log('');
        console.log(chalk.bold('Adversary Engine'));
        if (r.adversary && r.adversary.last) {
          const a = r.adversary.last;
          const rate = a.catchRateAny != null ? (a.catchRateAny * 100).toFixed(0) + '%' : '?';
          const rateColour = a.catchRateAny == null ? chalk.gray : (a.catchRateAny >= 0.9 ? chalk.green : chalk.red);
          console.log(`  ${r.adversary.totalRuns} run(s); last: ${a.attackCount} attacks, catch rate ${rateColour(rate)} (${a.startedAt})`);
        } else {
          console.log(chalk.gray('  no adversary runs yet — run `recall security adversary-run`'));
        }
        console.log('');
        console.log(chalk.bold('Negative-Promotion (microbial fade)'));
        if (r.negProm && r.negProm.available) {
          console.log(`  ${r.negProm.totalEvents} event(s) across ${r.negProm.distinctEntriesPenalized} entries`);
        } else {
          console.log(chalk.gray('  no negative-promotion events yet'));
        }
        console.log('');
        console.log(chalk.bold('Architect Review Queue (correlated-failure mitigation)'));
        if (r.archReview && r.archReview.available) {
          const a = r.archReview;
          const overdueColour = a.byStatus.overdue > 0 ? chalk.red : chalk.green;
          console.log(`  total=${a.totalItems}  queued=${chalk.yellow(a.byStatus.queued)}  approved=${chalk.green(a.byStatus['signed-approve'])}  rejected=${chalk.red(a.byStatus['signed-reject'])}  overdue=${overdueColour(a.byStatus.overdue)}`);
        } else {
          console.log(chalk.gray('  no architect-review items queued'));
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red(`security dashboard error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('drift-check')
    .description('Compare two windows of egress-scan ledger activity for defense drift (block rate / FP / scan frequency / detector mix). Reports no-drift / monitor / investigate / critical.')
    .option('--baseline-hours <n>', 'Lookback hours defining the baseline window', '168')
    .option('--current-hours <n>', 'Lookback hours defining the current window', '24')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const baselineHours = Number(opts.baselineHours);
        const currentHours = Number(opts.currentHours);
        if (!(baselineHours > currentHours)) throw new Error('--baseline-hours must be greater than --current-hours');

        const entries = listScans({ dataDir: cliConfig.getDataDir(), limit: 5000 });
        const nowMs = Date.now();
        const baselineCutoff = nowMs - baselineHours * 60 * 60 * 1000;
        const currentCutoff = nowMs - currentHours * 60 * 60 * 1000;
        const baselineEntries = entries.filter((e) => {
          const t = Date.parse(e.scannedAt);
          return Number.isFinite(t) && t >= baselineCutoff && t < currentCutoff;
        });
        const currentEntries = entries.filter((e) => {
          const t = Date.parse(e.scannedAt);
          return Number.isFinite(t) && t >= currentCutoff;
        });

        const baseline = summarizeLedger(baselineEntries, baselineHours - currentHours);
        const current = summarizeLedger(currentEntries, currentHours);
        const result = evaluateDrift({ baseline, current });
        result.baseline = baseline;
        result.current = current;

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const colour = result.decision === 'critical' ? chalk.red
                       : result.decision === 'investigate' ? chalk.yellow
                       : result.decision === 'monitor' ? chalk.cyan
                       : chalk.green;
          console.log('');
          console.log(colour.bold('Defense Drift: ' + result.decision.toUpperCase()));
          console.log(`Baseline window: last ${baselineHours - currentHours}h (ending ${currentHours}h ago)  scans=${baseline.scanCount}`);
          console.log(`Current window:  last ${currentHours}h  scans=${current.scanCount}`);
          console.log('');
          if (result.drifts.length === 0) {
            console.log(chalk.green('No drift detected within tolerances.'));
          } else {
            console.log(chalk.bold(`Drifts (${result.drifts.length}):`));
            for (const d of result.drifts) {
              const c = d.severity === 'critical' ? chalk.red : (d.severity === 'investigate' ? chalk.yellow : chalk.cyan);
              console.log(`  ${c(d.severity.toUpperCase())}  ${d.axis}: ${d.detail}`);
            }
          }
          console.log('');
        }
        if (result.decision === 'critical') process.exitCode = 2;
      } catch (err) {
        console.error(chalk.red(`security drift-check error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('decay-tiers')
    .description('Show the elevation-dependent decay tiers (basin.raw → ridge.canonical) and per-tier half-life + floor.')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const tiers = listTiers();
        if (opts.json) {
          console.log(JSON.stringify(tiers, null, 2));
          return;
        }
        console.log('');
        console.log(chalk.bold('Decay Tiers'));
        for (const [name, t] of Object.entries(tiers)) {
          const halfLifeReadable = t.halfLifeHours >= 24 ? `${(t.halfLifeHours / 24).toFixed(1)}d` : `${t.halfLifeHours}h`;
          console.log(`  ${name.padEnd(22)}  half-life=${halfLifeReadable.padStart(7)}  floor=${t.floor.toFixed(2)}  ${chalk.gray(t.label)}`);
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red(`security decay-tiers error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('decay-evaluate')
    .description('Evaluate a project KB for decay status by elevation tier. Reports per-status counts + archive candidates (entries below their tier floor).')
    .requiredOption('--project <id>', 'Project namespace to evaluate')
    .option('--category <name>', 'Limit to a single category')
    .option('--archive-only', 'Print only archive candidates')
    .option('--limit <n>', 'Max entries to print (per status)', '10')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const cfg = cliConfig.read();
        const store = meridian.init(cliConfig.getDataDir(), { llm: cfg.llm });
        const allEntries = [];
        const fetched = opts.category
          ? (() => { try { return store.listEntries(opts.project, { category: opts.category }) || []; } catch (_) { return []; } })()
          : (() => { try { return store.listEntries(opts.project) || []; } catch (_) { return []; } })();
        for (const e of fetched) {
          allEntries.push({ id: e.id, project: opts.project, category: e.category || opts.category || null, createdAt: e.createdAt, confidence: e.confidence });
        }
        const result = evaluateCorpus(allEntries);

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log('');
        console.log(chalk.bold('Decay Evaluation: ' + opts.project));
        console.log(`Total entries: ${result.total}`);
        console.log(`Fresh:         ${chalk.green(result.counts.fresh)}`);
        console.log(`Aging:         ${chalk.yellow(result.counts.aging)}`);
        console.log(`Stale:         ${chalk.yellow(result.counts.stale)}`);
        console.log(`Archive:       ${chalk.red(result.counts.archive)}`);
        console.log('');
        if (result.archiveCandidates.length > 0) {
          console.log(chalk.red.bold(`Archive candidates (showing first ${Math.min(Number(opts.limit), result.archiveCandidates.length)}):`));
          for (const e of result.archiveCandidates.slice(0, Number(opts.limit))) {
            console.log(`  ${e.entryId.padEnd(40)}  tier=${e.tier.padEnd(20)}  age=${Math.round(e.ageHours)}h  effConf=${e.effectiveConfidence.toFixed(4)}  (floor=${e.floor})`);
          }
          console.log('');
          console.log(chalk.gray('To archive these from the searchable space, route via knowledge-transition (audit ledger keeps the immutable record).'));
        }
        if (!opts.archiveOnly) {
          const samples = result.evaluations.filter((e) => e.status === 'stale').slice(0, Number(opts.limit));
          if (samples.length > 0) {
            console.log('');
            console.log(chalk.yellow.bold(`Stale (sample of ${samples.length}):`));
            for (const e of samples) {
              console.log(`  ${e.entryId.padEnd(40)}  tier=${e.tier.padEnd(20)}  age=${Math.round(e.ageHours)}h  effConf=${e.effectiveConfidence.toFixed(4)}`);
            }
          }
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red(`security decay-evaluate error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('bridge-degree-check')
    .description('Check the cross-project bridge graph for over-concentrated hubs (failure mode #7b: mother-tree fallacy). Reports exceedances + optional pruning suggestions.')
    .option('--relations <path>', 'JSON file: [{from, to, project?, createdAt?, confidence?}, ...]')
    .option('--cap-per-node <n>', 'Maximum allowed degree per node', '8')
    .option('--cap-per-project <n>', 'Optional: max edges per project (no default)')
    .option('--block-multiplier <n>', 'Decision: block when any degree exceeds cap*multiplier', '2')
    .option('--strategy <name>', 'Pruning strategy (oldest-first|lowest-confidence|random)', 'oldest-first')
    .option('--no-suggest', 'Skip pruning suggestions even if exceedances exist')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        if (!opts.relations) throw new Error('Provide --relations <path-to-json>');
        const relations = JSON.parse(fs.readFileSync(opts.relations, 'utf8'));
        const result = evaluateBridgeDegrees({
          relations,
          capPerNode: Number(opts.capPerNode),
          capPerProject: opts.capPerProject ? Number(opts.capPerProject) : null,
          blockMultiplier: Number(opts.blockMultiplier),
        });
        if (opts.suggest !== false && result.exceedances.length > 0) {
          result.pruningSuggestions = suggestPruning({ exceedances: result.exceedances, strategy: opts.strategy });
        }
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const colour = result.decision === 'block' ? chalk.red : (result.decision === 'requires_pruning' ? chalk.yellow : chalk.green);
          console.log('');
          console.log(colour.bold('Bridge Degree: ' + result.decision.toUpperCase()));
          console.log(`Nodes:       ${result.summary.totalNodes}`);
          console.log(`Edges:       ${result.summary.totalEdges}`);
          console.log(`Max degree:  ${result.summary.maxDegree} (cap=${result.summary.capPerNode}, block@${result.summary.capPerNode * result.summary.blockMultiplier})`);
          console.log(`Mean degree: ${result.summary.meanDegree}`);
          if (result.exceedances.length) {
            console.log('');
            console.log(chalk.yellow.bold(`Exceedances (${result.exceedances.length}):`));
            for (const e of result.exceedances) {
              console.log(`  • ${e.nodeId}  degree=${e.degree}  excess=${e.excess}`);
            }
          }
          if (result.pruningSuggestions && result.pruningSuggestions.length) {
            console.log('');
            console.log(chalk.gray.bold(`Pruning suggestions (strategy=${opts.strategy}):`));
            for (const p of result.pruningSuggestions) {
              console.log(`  • ${p.nodeId}: retire ${p.edgesToRetire.length} edge(s) → degree ${p.retainedDegree}`);
            }
          }
          console.log('');
        }
        if (result.decision === 'block') process.exitCode = 2;
      } catch (err) {
        console.error(chalk.red(`security bridge-degree-check error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('canary-plant')
    .description('Plant a signed canary entry in the trusted KB. Generates a unique marker token; entry never matches a real query, so any retrieval = alarm. Returns the suggestedKbEntry shape — pipe to recall add for actual KB insertion.')
    .option('--project <id>', 'Project namespace to plant in', 'recall-dev')
    .option('--label <text>', 'Optional label')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const r = plantCanary({ project: opts.project, dataDir: cliConfig.getDataDir(), label: opts.label });
        if (opts.json) {
          console.log(JSON.stringify(r, null, 2));
          return;
        }
        console.log('');
        console.log(chalk.green.bold('Canary Planted'));
        console.log(`Canary ID:    ${r.canaryId}`);
        console.log(`Marker:       ${r.marker}`);
        console.log(`Project:      ${r.entry.project}`);
        console.log(`Planted at:   ${r.entry.plantedAt}`);
        console.log('');
        console.log(chalk.gray('Suggested KB entry — pipe through `recall add` to insert into the trusted KB:'));
        console.log(chalk.gray(JSON.stringify(r.entry.suggestedKbEntry, null, 2)));
        console.log('');
        console.log(chalk.yellow('Any retrieval surfacing this marker is the alarm.'));
        console.log('');
      } catch (err) {
        console.error(chalk.red(`security canary-plant error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('canary-list')
    .description('List planted canaries from the canary ledger.')
    .option('--project <id>', 'Filter to a project')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const entries = listCanaries({ dataDir: cliConfig.getDataDir(), project: opts.project });
        if (opts.json) {
          console.log(JSON.stringify({ count: entries.length, entries }, null, 2));
          return;
        }
        if (!entries.length) {
          console.log(chalk.gray('No canaries planted yet. Plant one: recall security canary-plant --project recall-dev'));
          return;
        }
        console.log('');
        console.log(chalk.bold('Canary Ledger (' + entries.length + ' entries)'));
        for (const e of entries) {
          console.log(`#${String(e.sequence).padStart(4, ' ')}  ${e.canaryId}  ${e.project}  ${e.plantedAt}  ${e.label || ''}`);
        }
        console.log('');
      } catch (err) {
        console.error(chalk.red(`security canary-list error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('canary-check')
    .description('Scan content for any planted canary marker. Any hit is an alarm: only canary-checker scans should be reading canary content.')
    .option('--content <text>', 'Inline content to scan')
    .option('--file <path>', 'File to scan')
    .option('--source <kind>', 'Source descriptor for the audit log (e.g. "specialist-output", "moltbook-draft")', 'unknown')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        let content;
        if (opts.file) content = fs.readFileSync(opts.file, 'utf8');
        else if (opts.content) content = opts.content;
        else throw new Error('Provide one of --content or --file');
        const hits = detectCanaryHits({ content, source: opts.source, dataDir: cliConfig.getDataDir() });
        if (opts.json) {
          console.log(JSON.stringify({ hits }, null, 2));
          if (hits.length > 0) process.exitCode = 2;
          return;
        }
        if (hits.length === 0) {
          console.log(chalk.green('No canary hits.'));
          return;
        }
        console.log('');
        console.log(chalk.red.bold(`CANARY ALARM — ${hits.length} hit(s)`));
        for (const h of hits) {
          console.log(`  • ${h.canaryId} (${h.project})  source=${h.source}  offset=${h.firstOffset}`);
        }
        console.log('');
        console.log(chalk.red('Any canary hit means trusted-KB content reached an unintended surface.'));
        console.log(chalk.red('Investigate: who or what retrieved this canary? Was it a legitimate canary-checker?'));
        console.log('');
        process.exitCode = 2;
      } catch (err) {
        console.error(chalk.red(`security canary-check error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('canary-verify')
    .description('Verify the canary ledger hash chain.')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const r = verifyCanaryLedger({ dataDir: cliConfig.getDataDir() });
        if (opts.json) console.log(JSON.stringify(r, null, 2));
        else if (r.ok) console.log(chalk.green(`Canary ledger OK — ${r.entries || 0} entries, head ${r.headHash || '(empty)'}`));
        else console.log(chalk.red(`Canary ledger TAMPERED — failed at #${r.failedAt}, reason: ${r.reason}`));
        if (!r.ok) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(`security canary-verify error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  parent
    .command('dream-verify')
    .description('Verify the dream cycle ledger hash chain.')
    .option('--json', 'Print as JSON')
    .action((opts) => {
      try {
        const r = verifyDreamLedger({ dataDir: cliConfig.getDataDir() });
        if (opts.json) console.log(JSON.stringify(r, null, 2));
        else if (r.ok) console.log(chalk.green(`Dream cycle ledger OK — ${r.entries || 0} entries, head ${r.headHash || '(empty)'}`));
        else console.log(chalk.red(`Dream cycle ledger TAMPERED — failed at #${r.failedAt}, reason: ${r.reason}`));
        if (!r.ok) process.exitCode = 1;
      } catch (err) {
        console.error(chalk.red(`security dream-verify error: ${err.message}`));
        process.exitCode = 1;
      }
    });
};
