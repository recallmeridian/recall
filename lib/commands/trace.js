'use strict';

// recall trace — Trace Optimizer CLI surface (Slice 0).
//
// Wraps lib/trace-optimizer/* primitives. Slice 0 ships failure-basin
// detection over the existing IL agent-handoff hard-case stream. Future
// slices will add reflection, harness-patch recommendation, verification,
// and Meridian promotion per the Trace Optimizer plan.

const chalk = require('chalk');
const meridian = require('../meridian-core');
const cliConfig = require('../cli-config');
const agentHandoffs = require('../agent-handoff-ledger');
const { detectBasins } = require('../trace-optimizer/failure-basin-detector');
const { reflectOnBasin } = require('../trace-optimizer/trace-reflection');
const { recommendPatch } = require('../trace-optimizer/harness-patch');
const { verifyPatch } = require('../trace-optimizer/verification-runner');
const { promoteToKB, evaluatePromotionGate } = require('../trace-optimizer/meridian-promotion');
const fs = require('fs');
const { table } = require('../format');

// getKb returns a store handle pre-configured with the llm slot so any
// caller can grab store.getLlmProvider() without re-initializing the engine.
// Closes the boundary-audit (2026-05-12) finding about commands constructing
// OpenAICompatibleLLM directly.
function getKb() {
  const cfg = cliConfig.read();
  return meridian.init(cliConfig.getDataDir(), { llm: cfg.llm });
}

function buildLlmProvider() {
  // Legacy entry point preserved for any callers that don't have a kb handle
  // already. Opens a short-lived store, returns the LLM, closes the store.
  const kb = getKb();
  try {
    return kb.getLlmProvider();
  } finally {
    if (typeof kb.close === 'function') kb.close();
  }
}

module.exports = function(program) {
  const command = program
    .command('trace')
    .description('Trace Optimizer: cluster repeated agent failure signals into basins, then (later slices) reflect, recommend, verify, and promote');

  command
    .command('detect-basins')
    .description('Detect failure basins (>= --min-count hard cases sharing a normalized failure signal)')
    .option('--project <id>', 'Project namespace filter')
    .option('--min-count <n>', 'Minimum cluster size to qualify as a basin', '3')
    .option('--sample-limit <n>', 'Cap on sampleHandoffIds per basin', '10')
    .option('--limit <n>', 'Maximum basins to print', '50')
    .option('--json', 'Print basins as JSON')
    .action((opts) => {
      const kb = getKb();
      try {
        const mining = agentHandoffs.mineHardCases(kb, { project: opts.project, limit: 500 });
        const basins = detectBasins(mining.hardCases, {
          minCount: Number(opts.minCount),
          sampleLimit: Number(opts.sampleLimit),
        });
        const limited = basins.slice(0, Number(opts.limit));
        const summary = {
          entryType: 'failure_basin_detection',
          project: opts.project || null,
          minCount: Number(opts.minCount),
          hardCaseCount: mining.hardCases.length,
          basinCount: basins.length,
          printed: limited.length,
        };

        if (opts.json) {
          console.log(JSON.stringify({ summary, basins: limited }, null, 2));
          return;
        }

        console.log(chalk.bold('\nFailure Basin Detection\n'));
        if (opts.project) console.log(`Project:      ${opts.project}`);
        console.log(`Min count:    ${opts.minCount}`);
        console.log(`Hard cases:   ${mining.hardCaseCount || mining.hardCases.length}`);
        console.log(`Basins:       ${chalk.yellow(basins.length)} (printing ${limited.length})`);

        if (limited.length === 0) {
          console.log(chalk.gray('\nNo basins detected at this threshold.'));
          return;
        }

        console.log('');
        table(limited.map((basin) => [
          basin.id,
          String(basin.count),
          basin.agents.join(', '),
          basin.taskTypes.join(', '),
          basin.pattern.slice(0, 80),
        ]), ['ID', 'Count', 'Agents', 'TaskTypes', 'Pattern']);
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      } finally {
        kb.close();
      }
    });

  command
    .command('reflect')
    .description('Slice 1 — call the configured LLMProvider to reflect on the top failure basin(s) and emit candidate root-cause + next-actions reflections')
    .option('--project <id>', 'Project namespace filter')
    .option('--min-count <n>', 'Minimum basin size to qualify', '3')
    .option('--top <n>', 'Number of top basins to reflect on', '1')
    .option('--sample-handoffs <n>', 'Max underlying handoffs to include per reflection', '5')
    .option('--temperature <t>', 'LLM temperature override')
    .option('--json', 'Print reflections as JSON')
    .action(async (opts) => {
      const kb = getKb();
      try {
        const llm = buildLlmProvider();
        const mining = agentHandoffs.mineHardCases(kb, { project: opts.project, limit: 500 });
        const basins = detectBasins(mining.hardCases, { minCount: Number(opts.minCount) });
        const targetBasins = basins.slice(0, Number(opts.top));

        if (targetBasins.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify({ basins: [], reflections: [], reason: 'no basins above threshold' }, null, 2));
            return;
          }
          console.log(chalk.gray(`\nNo basins at min-count=${opts.minCount}. Lower threshold or collect more handoffs.\n`));
          return;
        }

        const allHandoffs = agentHandoffs.listHandoffs(kb, { project: opts.project, limit: 500 });
        const sampleLimit = Number(opts.sampleHandoffs);

        const out = [];
        for (const basin of targetBasins) {
          const samples = allHandoffs
            .filter((h) => basin.sampleHandoffIds.includes(h.id))
            .slice(0, sampleLimit);
          const reflection = await reflectOnBasin(basin, samples, llm, {
            temperature: opts.temperature !== undefined ? Number(opts.temperature) : undefined,
          });
          basin.reflection = reflection;
          basin.promotionStatus = reflection.parseFailed ? 'pending_reflection' : 'pending_recommendation';
          out.push({ basin });
        }

        if (opts.json) {
          console.log(JSON.stringify({ reflections: out }, null, 2));
          return;
        }

        console.log(chalk.bold('\nTrace Reflection (Slice 1)\n'));
        console.log(`Provider:    ${chalk.cyan(llm.describe().provider)}  (model: ${llm.describe().defaultModel})`);
        console.log(`Reflections: ${out.length}\n`);
        for (const entry of out) {
          const b = entry.basin;
          const r = b.reflection;
          console.log(chalk.bold(`Basin: ${b.id}`));
          console.log(`  Pattern:    ${b.pattern}`);
          console.log(`  Count:      ${b.count}`);
          console.log(`  Confidence: ${r.confidence.toFixed(2)}${r.parseFailed ? chalk.red(' (parse failed)') : ''}`);
          console.log(`  Root cause: ${r.rootCause || chalk.dim('(empty)')}`);
          if (r.contributingFactors.length > 0) {
            console.log(`  Contributing factors:`);
            r.contributingFactors.forEach((f) => console.log(`    - ${f}`));
          }
          if (r.recommendedNextActions.length > 0) {
            console.log(`  Recommended next actions:`);
            r.recommendedNextActions.forEach((a) => console.log(`    - ${a}`));
          }
          console.log('');
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      } finally {
        kb.close();
      }
    });

  command
    .command('recommend')
    .description('Slice 2 — call the configured LLMProvider to recommend a concrete patch for the top failure basin(s); chains detect-basins -> reflect -> recommend in one shot')
    .option('--project <id>', 'Project namespace filter')
    .option('--min-count <n>', 'Minimum basin size to qualify', '3')
    .option('--top <n>', 'Number of top basins to recommend on', '1')
    .option('--sample-handoffs <n>', 'Max underlying handoffs per reflection', '5')
    .option('--temperature <t>', 'LLM temperature override')
    .option('--json', 'Print basin + reflection + recommendation as JSON')
    .action(async (opts) => {
      const kb = getKb();
      try {
        const llm = buildLlmProvider();
        const mining = agentHandoffs.mineHardCases(kb, { project: opts.project, limit: 500 });
        const basins = detectBasins(mining.hardCases, { minCount: Number(opts.minCount) });
        const targetBasins = basins.slice(0, Number(opts.top));

        if (targetBasins.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify({ basins: [], recommendations: [], reason: 'no basins above threshold' }, null, 2));
            return;
          }
          console.log(chalk.gray(`\nNo basins at min-count=${opts.minCount}. Lower threshold or collect more handoffs.\n`));
          return;
        }

        const allHandoffs = agentHandoffs.listHandoffs(kb, { project: opts.project, limit: 500 });
        const sampleLimit = Number(opts.sampleHandoffs);
        const temperature = opts.temperature !== undefined ? Number(opts.temperature) : undefined;

        const out = [];
        for (const basin of targetBasins) {
          const samples = allHandoffs
            .filter((h) => basin.sampleHandoffIds.includes(h.id))
            .slice(0, sampleLimit);
          const reflection = await reflectOnBasin(basin, samples, llm, { temperature });
          basin.reflection = reflection;
          const recommendation = await recommendPatch(basin, reflection, llm, { temperature });
          basin.recommendation = recommendation;
          basin.promotionStatus = recommendation.parseFailed
            ? 'pending_recommendation'
            : 'pending_verification';
          out.push({ basin });
        }

        if (opts.json) {
          console.log(JSON.stringify({ recommendations: out }, null, 2));
          return;
        }

        console.log(chalk.bold('\nTrace Recommendation (Slice 2)\n'));
        console.log(`Provider:        ${chalk.cyan(llm.describe().provider)}  (model: ${llm.describe().defaultModel})`);
        console.log(`Recommendations: ${out.length}\n`);
        for (const entry of out) {
          const b = entry.basin;
          const r = b.recommendation;
          console.log(chalk.bold(`Basin: ${b.id}`));
          console.log(`  Pattern:        ${b.pattern}`);
          console.log(`  Count:          ${b.count}`);
          console.log(`  Patch kind:     ${chalk.cyan(r.patchKind)}${r.parseFailed ? chalk.red(' (parse failed)') : ''}`);
          console.log(`  Confidence:     ${r.confidence.toFixed(2)}`);
          console.log(`  Impact:         ${r.estimatedImpact}`);
          if (r.target.file) {
            const sec = r.target.section ? `  [${r.target.section}]` : '';
            const loc = r.target.locator ? `  (${r.target.locator})` : '';
            console.log(`  Target:         ${r.target.file}${sec}${loc}`);
          }
          if (r.change.diffSummary) {
            console.log(`  Diff:           ${r.change.diffSummary}`);
          }
          if (r.rationale) {
            console.log(`  Rationale:      ${r.rationale}`);
          }
          if (r.riskNotes.length > 0) {
            console.log(`  Risks:`);
            r.riskNotes.forEach((risk) => console.log(`    - ${risk}`));
          }
          console.log('');
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      } finally {
        kb.close();
      }
    });

  command
    .command('verify')
    .description('Slice 3 — apply the top basin\'s recommended patch to a temp copy of the target file, optionally rerun tests, report whether the patch is applicable + syntactically valid')
    .option('--project <id>', 'Project namespace filter')
    .option('--min-count <n>', 'Minimum basin size to qualify', '3')
    .option('--top <n>', 'Number of top basins to verify', '1')
    .option('--sample-handoffs <n>', 'Max underlying handoffs per reflection', '5')
    .option('--temperature <t>', 'LLM temperature override')
    .option('--patch-input <path>', 'Verify a HarnessPatchRecommendation JSON file directly (skip basin mining + LLM)')
    .option('--repo-root <path>', 'Repository root that target file paths are resolved against (default: current dir)')
    .option('--run-tests <cmd>', 'Shell command to run after applying patch (e.g. "npm test" or "npx jest path/to.test.js")')
    .option('--test-timeout-ms <n>', 'Timeout for --run-tests command', '60000')
    .option('--json', 'Print verification results as JSON')
    .action(async (opts) => {
      const repoRoot = opts.repoRoot || process.cwd();
      const runTests = opts.runTests;
      const testTimeoutMs = Number(opts.testTimeoutMs);

      // Patch-input mode: skip basin mining + LLM, verify a JSON patch directly.
      if (opts.patchInput) {
        try {
          const patch = JSON.parse(fs.readFileSync(opts.patchInput, 'utf8'));
          const result = verifyPatch(patch, { repoRoot, runTests, testTimeoutMs });
          if (opts.json) {
            console.log(JSON.stringify({ verifications: [result] }, null, 2));
            return;
          }
          printVerification(result);
        } catch (err) {
          console.error(chalk.red(`Error reading --patch-input: ${err.message}`));
          process.exitCode = 1;
        }
        return;
      }

      const kb = getKb();
      try {
        const llm = buildLlmProvider();
        const mining = agentHandoffs.mineHardCases(kb, { project: opts.project, limit: 500 });
        const basins = detectBasins(mining.hardCases, { minCount: Number(opts.minCount) });
        const targetBasins = basins.slice(0, Number(opts.top));

        if (targetBasins.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify({ verifications: [], reason: 'no basins above threshold' }, null, 2));
            return;
          }
          console.log(chalk.gray(`\nNo basins at min-count=${opts.minCount}.\n`));
          return;
        }

        const allHandoffs = agentHandoffs.listHandoffs(kb, { project: opts.project, limit: 500 });
        const sampleLimit = Number(opts.sampleHandoffs);
        const temperature = opts.temperature !== undefined ? Number(opts.temperature) : undefined;

        const out = [];
        for (const basin of targetBasins) {
          const samples = allHandoffs
            .filter((h) => basin.sampleHandoffIds.includes(h.id))
            .slice(0, sampleLimit);
          const reflection = await reflectOnBasin(basin, samples, llm, { temperature });
          basin.reflection = reflection;
          const recommendation = await recommendPatch(basin, reflection, llm, { temperature });
          basin.recommendation = recommendation;
          const verification = verifyPatch(recommendation, {
            repoRoot, basinId: basin.id, runTests, testTimeoutMs,
          });
          basin.verification = verification;
          basin.promotionStatus = verification.status === 'applied' && verification.syntaxValid !== false
            ? 'pending_promotion'
            : 'verification_failed';
          out.push({ basin });
        }

        if (opts.json) {
          console.log(JSON.stringify({ verifications: out }, null, 2));
          return;
        }

        console.log(chalk.bold('\nTrace Verification (Slice 3)\n'));
        console.log(`Provider:      ${chalk.cyan(llm.describe().provider)}  (model: ${llm.describe().defaultModel})`);
        console.log(`Repo root:     ${repoRoot}`);
        console.log(`Verifications: ${out.length}\n`);
        for (const entry of out) {
          const b = entry.basin;
          console.log(chalk.bold(`Basin: ${b.id}`));
          console.log(`  Pattern:     ${b.pattern}  (count ${b.count})`);
          console.log(`  Patch:       ${b.recommendation.patchKind}  ->  ${b.recommendation.target.file || chalk.dim('(no target)')}`);
          printVerification(b.verification, '  ');
          console.log('');
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      } finally {
        kb.close();
      }
    });

  command
    .command('promote')
    .description('Slice 4 — promote a verified basin to a durable KB lesson. Typed promotion gate: verification.status=applied, syntaxValid!=false, recommendation present + confidence >= threshold. Default --dry-run.')
    .option('--project <id>', 'Project namespace filter')
    .option('--min-count <n>', 'Minimum basin size to qualify', '3')
    .option('--top <n>', 'Number of top basins to attempt to promote', '1')
    .option('--sample-handoffs <n>', 'Max underlying handoffs per reflection', '5')
    .option('--temperature <t>', 'LLM temperature override')
    .option('--min-confidence <n>', 'Minimum recommendation confidence to allow promotion', '0.6')
    .option('--category <name>', 'KB category to write into', 'lessons')
    .option('--repo-root <path>', 'Repo root for verification target paths (default: current dir)')
    .option('--run-tests <cmd>', 'Optional test command to rerun during verification')
    .option('--commit', 'Actually write to the KB. Without this flag the command is a dry-run.')
    .option('--json', 'Print result as JSON')
    .action(async (opts) => {
      const repoRoot = opts.repoRoot || process.cwd();
      const dryRun = !opts.commit;
      const minConfidence = Number(opts.minConfidence);
      const kb = getKb();
      try {
        const llm = buildLlmProvider();
        const mining = agentHandoffs.mineHardCases(kb, { project: opts.project, limit: 500 });
        const basins = detectBasins(mining.hardCases, { minCount: Number(opts.minCount) });
        const targetBasins = basins.slice(0, Number(opts.top));

        if (targetBasins.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify({ promotions: [], reason: 'no basins above threshold' }, null, 2));
            return;
          }
          console.log(chalk.gray(`\nNo basins at min-count=${opts.minCount}.\n`));
          return;
        }

        const allHandoffs = agentHandoffs.listHandoffs(kb, { project: opts.project, limit: 500 });
        const sampleLimit = Number(opts.sampleHandoffs);
        const temperature = opts.temperature !== undefined ? Number(opts.temperature) : undefined;

        const out = [];
        for (const basin of targetBasins) {
          const samples = allHandoffs
            .filter((h) => basin.sampleHandoffIds.includes(h.id))
            .slice(0, sampleLimit);
          basin.reflection = await reflectOnBasin(basin, samples, llm, { temperature });
          basin.recommendation = await recommendPatch(basin, basin.reflection, llm, { temperature });
          basin.verification = verifyPatch(basin.recommendation, {
            repoRoot,
            basinId: basin.id,
            runTests: opts.runTests,
            testTimeoutMs: 60_000,
          });
          const promotion = promoteToKB(basin, kb, {
            minConfidence,
            category: opts.category,
            dryRun,
          });
          basin.promotion = promotion;
          basin.promotionStatus = promotion.promoted ? 'promoted' : (promotion.gate.ok ? 'dry_run' : 'gate_failed');
          out.push({ basin });
        }

        if (opts.json) {
          console.log(JSON.stringify({ promotions: out, dryRun }, null, 2));
          return;
        }

        console.log(chalk.bold('\nTrace Promotion (Slice 4)\n'));
        console.log(`Provider:        ${chalk.cyan(llm.describe().provider)}  (model: ${llm.describe().defaultModel})`);
        console.log(`Mode:            ${dryRun ? chalk.yellow('DRY-RUN (pass --commit to write)') : chalk.green('COMMIT')}`);
        console.log(`Min confidence:  ${minConfidence}`);
        console.log(`Promotions:      ${out.length}\n`);
        for (const entry of out) {
          const b = entry.basin;
          const p = b.promotion;
          console.log(chalk.bold(`Basin: ${b.id}`));
          console.log(`  Pattern:   ${b.pattern}  (count ${b.count})`);
          console.log(`  Gate:      ${p.gate.ok ? chalk.green('PASS') : chalk.red('FAIL')}`);
          if (!p.gate.ok) {
            console.log(`  Reasons:`);
            p.gate.reasons.forEach((r) => console.log(`    - ${r}`));
          }
          if (p.promoted) {
            console.log(`  Promoted:  ${chalk.green('yes')}  KB id: ${chalk.cyan(p.entry.id)}`);
          } else if (p.reason === 'dry_run') {
            console.log(`  Promoted:  ${chalk.yellow('no (dry-run)')}`);
          } else {
            console.log(`  Promoted:  ${chalk.gray('no')}  reason: ${p.reason}`);
          }
          console.log('');
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      } finally {
        kb.close();
      }
    });
};

function printVerification(v, indent = '') {
  const colorByStatus = {
    applied: chalk.green,
    apply_failed: chalk.red,
    unsupported: chalk.gray,
    target_missing: chalk.red,
    before_not_found: chalk.yellow,
    after_no_change: chalk.yellow,
  };
  const color = colorByStatus[v.status] || chalk.white;
  console.log(`${indent}Status:      ${color(v.status)}`);
  console.log(`${indent}Applied:     ${v.applied ? chalk.green('yes') : chalk.gray('no')}`);
  if (v.syntaxValid !== null) {
    console.log(`${indent}Syntax:      ${v.syntaxValid ? chalk.green('valid') : chalk.red('INVALID')}`);
  }
  if (v.tempCopy) console.log(`${indent}Temp copy:   ${chalk.dim(v.tempCopy)}`);
  if (v.notes.length > 0) {
    console.log(`${indent}Notes:`);
    v.notes.forEach((n) => console.log(`${indent}  - ${n}`));
  }
  if (v.testsRun) {
    const t = v.testsRun;
    const passed = t.passCount === null ? '?' : t.passCount;
    const failed = t.failCount === null ? '?' : t.failCount;
    console.log(`${indent}Tests:       ${t.command}  ->  pass=${passed} fail=${failed} exit=${t.exitCode}`);
  }
}
