'use strict';

// Intelligence Loop — end-to-end cycle runner.
//
// Closes the loop on a single specialist by walking:
//   1. Run specialist v_current against PROPOSER-VISIBLE eval cases
//   2. Score: passing vs failing per case (using bench scoring rules)
//   3. Failures become "basins" for this specialist
//   4. Multi-perspective reflection on each basin
//   5. Synthesize an auto-proposal (prompt patch heuristic) — sees ONLY
//      visible failures + visible clean-control samples; never holdout
//   6. Replay candidate against visible + HOLDOUT in one pass
//      (runVisibleAndHoldout) — emits both scores plus a combined full
//      passRate. Both numbers feed the promotion gate.
//   7. Constraint-gate the promotion decision (anti-Goodhart: holdout
//      regression vetoes visible improvement)
//   8. Append a cycle ledger entry — every step traceable
//
// What this module is NOT:
//   - It does NOT run the LLM by itself. It composes existing modules.
//   - It does NOT auto-promote. The promotion gate decision is recorded;
//     the operator (or a follow-up command) does the actual promote.
//   - It does NOT show the holdout set to the PROPOSER side
//     (synthesizeAutoProposal). The EVALUATOR side (runVisibleAndHoldout)
//     is allowed to compute both metrics — they're what the promotion
//     gate reads. Anti-Goodhart discipline per §10 of the 2026-05-12
//     brainstorm.
//
// Refinements queued by commit 915e0b6 (0.19.0 closed-loop demo) and
// landed in this revision:
//   - synthesizeAutoProposal accepts `cleanControlSamples` for contrastive
//     vocabulary. Naive additive nudges overfit (push the model toward
//     "find something to flag"); the contrastive section pulls it back
//     toward "don't flag clean controls."
//   - runVisibleAndHoldout evaluates a candidate against both sets in
//     one call, so the cycle no longer requires the caller to chain
//     two separate runCaseSet invocations and reassemble the metrics.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { evaluatePromotion } = require('../security/promotion-gate');
const { reflectMultiPerspective } = require('../trace-optimizer/trace-reflection');
const sidecar = require('./auto-nudge-sidecar');

function cycleLedgerPath(opts = {}) {
  return opts.ledgerPath || path.join(opts.dataDir || '', 'intelligence', 'cycle-runner-ledger.jsonl');
}

function ensureFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', 'utf8');
}

function readLedger(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
}

function entryHash(entry) {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify({
    sequence: entry.sequence,
    previousHash: entry.previousHash,
    cycleId: entry.cycleId,
    specialistId: entry.specialistId,
    specialistVersionBefore: entry.specialistVersionBefore,
    startedAt: entry.startedAt,
    visibleScoreBefore: entry.visibleScoreBefore,
    visibleScoreAfter: entry.visibleScoreAfter,
    holdoutScoreAfter: entry.holdoutScoreAfter,
    reflectionRootCauses: entry.reflectionRootCauses,
    proposalKind: entry.proposalKind,
    gateDecision: entry.gateDecision,
  })).digest('hex');
}

// ---- Scoring: same logic as run-specialist-benchmarks.js -------------
// A case passes if at least half the expected.shouldFlag keywords appear
// in the model output AND, when present, expected.expectedDoctrines has
// at least one overlap with model output.

function scoreModelOutput(modelOutput, expected, caseDef) {
  const checks = [];
  if (expected.shouldFlag) {
    const concat = JSON.stringify(modelOutput || {}).toLowerCase();
    const matched = expected.shouldFlag.filter((kw) => concat.includes(String(kw).toLowerCase()));
    const threshold = Math.ceil(expected.shouldFlag.length / 2);
    checks.push({
      kind: 'shouldFlag',
      pass: matched.length >= threshold,
      matched, expected: expected.shouldFlag, threshold,
    });
  }
  if (expected.expectedDoctrines && expected.expectedDoctrines.length > 0) {
    const got = ((modelOutput && modelOutput.doctrineFlags) || []).map((d) => d.doctrine);
    checks.push({
      kind: 'expectedDoctrines',
      pass: expected.expectedDoctrines.some((d) => got.includes(d)),
      matched: got.filter((g) => expected.expectedDoctrines.includes(g)),
      expected: expected.expectedDoctrines,
    });
  }
  // Control-no-doctrine-flags: case explicitly expects NO flags
  if (expected.controlNoDoctrineFlags) {
    const got = ((modelOutput && modelOutput.doctrineFlags) || []);
    checks.push({
      kind: 'controlNoDoctrineFlags',
      pass: got.length === 0,
      matched: got.map((d) => d.doctrine),
    });
  }
  return {
    caseId: caseDef.id,
    pass: checks.length > 0 && checks.every((c) => c.pass),
    checks,
  };
}

// Run a single eval case against the specialist via the spawnSync CLI
// pattern (matches the existing benchmark runner so results are
// directly comparable).
//
// opts.bundleOverride (object): an in-memory specialist bundle.  When
// present, the CLI is invoked with --bundle-stdin and the JSON-serialized
// bundle is piped in on stdin.  This lets runFullCycle score a CANDIDATE
// bundle without first writing it to disk — required for the auto-apply
// flow so a non-promote verdict doesn't leave a half-applied patch on
// disk that has to be rolled back.
// Default LLM temperature for eval-cycle runs. 0 is intentional: the IL is
// trying to detect signal from prompt changes against the noise of LLM
// sampling. A higher temperature inflates the noise floor and makes small
// prompt-improvements indistinguishable from random variance. The 0.27.1
// retrospective was triggered by exactly this — single-cycle "+5.7pp" turned
// out to be within a ±15pp variance band on the same specialist.
const EVAL_TEMPERATURE_DEFAULT = 0;

function runSingleCase(specialistId, caseDef, opts = {}) {
  const { spawnSync } = require('child_process');
  // Default repo root is the package root (two levels up from this file).
  // Falling back to a hardcoded absolute path is a private-path leak; resolve
  // dynamically so the readiness scanner is happy and other contributors can
  // use this without patching it.
  const defaultRepoRoot = opts.repoRoot || path.resolve(__dirname, '..', '..');
  const meridianPath = opts.meridianPath || path.join(defaultRepoRoot, 'bin', 'meridian.js');
  const inputJson = typeof caseDef.input === 'string' ? caseDef.input : JSON.stringify(caseDef.input);
  const temperature = Number.isFinite(opts.temperature) ? opts.temperature : EVAL_TEMPERATURE_DEFAULT;
  const args = [
    meridianPath, 'intelligence', 'specialist-run', specialistId,
    '--input', inputJson,
    '--query', String(caseDef.description || caseDef.id).slice(0, 100),
    '--outcome', 'unknown',
    '--temperature', String(temperature),
    '--json',
  ];
  if (opts.model) {
    args.push('--model', String(opts.model));
  }
  const spawnOpts = { encoding: 'utf8', timeout: 90_000 };
  if (opts.bundleOverride) {
    args.push('--bundle-stdin');
    spawnOpts.input = JSON.stringify(opts.bundleOverride);
  }
  const result = spawnSync(process.execPath, args, spawnOpts);

  if (result.status !== 0) {
    return { caseId: caseDef.id, pass: false, reason: 'cli_failed', stderr: (result.stderr || '').slice(-300) };
  }
  let parsedRun;
  try { parsedRun = JSON.parse(result.stdout); }
  catch (e) { return { caseId: caseDef.id, pass: false, reason: 'cli_output_unparseable' }; }

  const outputText = parsedRun && parsedRun.run && parsedRun.run.output && parsedRun.run.output.text;
  let modelObj = null;
  if (typeof outputText === 'string') {
    const fenced = outputText.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const candidate = fenced ? fenced[1] : outputText.trim();
    try { modelObj = JSON.parse(candidate); } catch (_) {
      const m = candidate.match(/\{[\s\S]*\}/);
      if (m) { try { modelObj = JSON.parse(m[0]); } catch (_) {} }
    }
  }
  if (!modelObj) {
    return { caseId: caseDef.id, pass: false, reason: 'model_output_not_json', rawTail: String(outputText || '').slice(-200) };
  }
  const scored = scoreModelOutput(modelObj, caseDef.expected || {}, caseDef);
  return {
    ...scored,
    modelOutput: modelObj,
    tokens: parsedRun.run && parsedRun.run.output && parsedRun.run.output.usage,
  };
}

// Aggregate N runs of the same case into one decision.
// A case is considered passing if it passes a strict majority of attempts
// (≥ ceil(N/2)). The per-case passRate (number of passes / N) is also
// retained so callers can compute variance and surface flaky cases.
function aggregateCaseRuns(caseDef, runs) {
  const passCount = runs.filter((r) => r.pass).length;
  const threshold = Math.ceil(runs.length / 2);
  const passRate = runs.length ? passCount / runs.length : 0;
  return {
    caseId: caseDef.id,
    pass: passCount >= threshold,
    repeats: runs.length,
    passCount,
    threshold,
    passRate,
    // A "flaky" case is one whose pass/fail decision is unstable across
    // repeats — passed at least once AND failed at least once. These are
    // the cases that single-cycle measurement gets wrong.
    flaky: passCount > 0 && passCount < runs.length,
    runs, // detailed per-run results for debugging
    // For backward compat with single-run callers that read `.checks`:
    checks: runs[0] ? runs[0].checks : undefined,
  };
}

function runCaseSet(specialistId, cases, opts = {}) {
  // opts.bundleOverride is forwarded into each runSingleCase invocation;
  // tests pass it through to avoid spawning real CLI processes.
  // opts.repeat (default 1) controls how many times each case is run;
  // the case is considered passing if a strict majority of repeats pass.
  const repeat = Math.max(1, Number.isFinite(opts.repeat) ? opts.repeat : 1);
  const aggregated = cases.map((c) => {
    const runs = [];
    for (let i = 0; i < repeat; i += 1) {
      runs.push(runSingleCase(specialistId, c, opts));
    }
    return aggregateCaseRuns(c, runs);
  });
  const passCount = aggregated.filter((r) => r.pass).length;
  const flakyCount = aggregated.filter((r) => r.flaky).length;
  // Variance of the per-case passRate distribution — gives a one-number
  // signal for "how noisy is this measurement." Range 0..0.25 (max at
  // p=0.5). High variance + same passRate across versions means the
  // measurement itself is unstable, not the specialist.
  const passRates = aggregated.map((r) => r.passRate);
  const meanPassRate = passRates.length ? passRates.reduce((a, b) => a + b, 0) / passRates.length : 0;
  const variance = passRates.length
    ? passRates.reduce((acc, p) => acc + (p - meanPassRate) ** 2, 0) / passRates.length
    : 0;
  return {
    total: cases.length,
    passCount,
    failCount: cases.length - passCount,
    passRate: cases.length ? passCount / cases.length : 0,
    repeat,
    flakyCount,
    meanCasePassRate: meanPassRate,
    casePassRateVariance: variance,
    results: aggregated,
  };
}

// Convert a set of failing eval cases into a "basin" shape that the
// existing trace-reflection module accepts. We don't need real
// embeddings here — a basin is just "a cluster of failures with a
// shared pattern descriptor."
function buildBasinFromFailures(specialistId, failures) {
  const sampleIds = failures.map((f) => f.caseId);
  const expectedSummary = failures.map((f) => {
    const flags = (f.checks || []).filter((c) => !c.pass).map((c) => c.kind + ':' + (c.expected || []).join(','));
    return { caseId: f.caseId, missingExpectations: flags };
  });
  return {
    pattern: 'specialist=' + specialistId + ' failing-cases',
    count: failures.length,
    agents: [specialistId],
    taskTypes: ['eval-case'],
    projects: ['recall-dev'],
    sampleHandoffIds: sampleIds,
    rawSamples: expectedSummary,
  };
}

// Heuristic auto-proposal generator: given a reflection and the failing
// eval cases, propose ONE of:
//   - prompt_patch: append guidance to the system prompt
//   - retrieval_recipe_patch: adjust retrieval categories/limits
//   - eval_set_addition: just record the failing cases for follow-up
//
// MVP: only prompt_patch.  The patch appends:
//   (a) ADDITIONAL REVIEW VOCABULARY — positive keywords drawn from
//       failing-case `expected` (additive nudge).
//   (b) DO NOT OVER-FLAG — contrastive guidance drawn from
//       `cleanControlSamples`. This block is the fix for the eval-15
//       overfit observed in commit 915e0b6: a purely additive nudge
//       pushes the model to "find something to flag" and over-fires on
//       clean controls. The contrastive section pulls it back by
//       enumerating clean-control input shapes as anti-examples, and —
//       when clean controls actually failed (spurious flag) — calling
//       out the specific doctrines NOT to invoke.
//
// cleanControlSamples shape (per element):
//   { caseId, description?, pass: bool, checks: [...] }
// Caller can build this via extractCleanControlSamples(caseSetResult,
// caseDefs).  Defaults to [] so existing call sites stay green.
//
// Anti-Goodhart contract: cleanControlSamples MUST come from the
// proposer-visible set only.  Holdout samples never enter this function.
function synthesizeAutoProposal({
  specialistId,
  currentPrompt,
  reflection,
  failures,
  cleanControlSamples = [],
}) {
  // Gather positive vocabulary from failing cases.
  const expectedKeywords = new Set();
  for (const f of failures) {
    for (const c of (f.checks || [])) {
      if (c.pass) continue;
      if (Array.isArray(c.expected)) {
        for (const k of c.expected) expectedKeywords.add(String(k));
      }
    }
  }
  const kwList = Array.from(expectedKeywords);

  // Gather contrastive vocabulary from clean controls.
  //   - cleanInputs:  short input descriptors of clean controls used as
  //     anti-examples ("inputs of this shape are clean; do not flag").
  //   - avoidDoctrines:  doctrines that fired spuriously on a clean
  //     control (the control FAILED because the model flagged it).
  //     These get an explicit "do not invoke X on clean content" line.
  const cleanInputs = [];
  const avoidDoctrinesSet = new Set();
  for (const cc of (cleanControlSamples || [])) {
    const desc = String((cc && (cc.description || cc.caseId)) || '').trim();
    if (desc) cleanInputs.push(desc.slice(0, 120));
    if (cc && cc.pass === false) {
      const failedControl = (cc.checks || []).find(
        (c) => c && c.kind === 'controlNoDoctrineFlags' && c.pass === false,
      );
      if (failedControl && Array.isArray(failedControl.matched)) {
        for (const d of failedControl.matched) avoidDoctrinesSet.add(String(d));
      }
    }
  }
  const avoidDoctrines = Array.from(avoidDoctrinesSet);

  // Build the prompt patch.
  const lines = [
    '',
    'ADDITIONAL REVIEW VOCABULARY (auto-generated from failure-basin reflection):',
    'When flagging the relevant doctrine, include one or more of these specific terms',
    'so downstream evaluators recognize the citation:',
    ...kwList.map((k) => `  - "${k}"`),
  ];

  const hasContrastive = cleanInputs.length > 0 || avoidDoctrines.length > 0;
  if (hasContrastive) {
    lines.push(
      '',
      'DO NOT OVER-FLAG (contrastive guidance from clean controls):',
      'Inputs of the following shapes are CLEAN.  Flagging them is a false positive.',
      'Prefer NO flag over a spurious flag when an input resembles these:',
    );
    for (const desc of cleanInputs) lines.push(`  - "${desc}"`);
    if (avoidDoctrines.length > 0) {
      lines.push(
        '',
        'Specifically, do NOT invoke the following doctrines on clean content unless',
        'there is unambiguous evidence in the input:',
      );
      for (const d of avoidDoctrines) lines.push(`  - ${d}`);
    }
  }

  lines.push(
    '',
    'Reflection root cause: ' + (reflection && reflection.merged && reflection.merged.rootCause
      ? reflection.merged.rootCause.slice(0, 200)
      : '(none)'),
  );

  const guidance = lines.join('\n');
  const newPrompt = (currentPrompt || '') + '\n' + guidance;

  // Patch identity includes contrastive inputs so the same failure set
  // with different controls produces a different proposalId.  The patch
  // IS different — same id would falsely imply equivalence.
  const patchId = 'autoprop-' + crypto.createHash('sha256').update([
    specialistId,
    kwList.join('|'),
    cleanInputs.join('|'),
    avoidDoctrines.join('|'),
  ].join('||')).digest('hex').slice(0, 12);

  const summaryParts = [
    'Auto-generated prompt patch: append vocabulary nudge for ' + kwList.length + ' keyword(s) from failing eval cases',
  ];
  if (hasContrastive) {
    summaryParts.push(
      'plus contrastive guidance from ' + cleanInputs.length + ' clean control(s)'
      + (avoidDoctrines.length > 0 ? ' and ' + avoidDoctrines.length + ' avoid-doctrine(s)' : ''),
    );
  }

  // Capture which reflection mode produced the rootCause + how strongly
  // the lenses agreed.  Low consensus = lenses disagreed = the patch
  // should get more human review.  When the caller passed a
  // single-perspective reflection these fields are null/false; the
  // ledger entry can then distinguish single-shot from multi-perspective
  // cycles in post-hoc analysis.
  const reflectionMeta = {
    multiPerspective: Boolean(reflection && reflection.agreement),
    rootCauseConsensus: (reflection && reflection.agreement && Number.isFinite(reflection.agreement.rootCauseConsensus))
      ? reflection.agreement.rootCauseConsensus
      : null,
    perspectiveCount: (reflection && reflection.agreement && reflection.agreement.perspectiveCount) || null,
    lenses: (reflection && reflection.merged && reflection.merged.lenses) || null,
  };

  return {
    proposalId: patchId,
    specialistId,
    kind: 'prompt_patch',
    summary: summaryParts.join('; '),
    patch: {
      kind: 'prompt_patch',
      prompt: newPrompt,        // full concatenated prompt (back-compat)
      guidance,                  // ONLY the new nudge text — sidecar writes use this
                                 // so we don't re-duplicate the original prompt on disk
      keywordsAdded: kwList,
      contrastiveInputs: cleanInputs,
      avoidDoctrines,
    },
    reflectionMeta,
    predictedImpact: hasContrastive
      ? 'Expect failing cases to start matching their expected.shouldFlag keywords; clean controls should NOT regress because the contrastive section explicitly pulls the model back from spurious flags'
      : 'Expect failing cases to start matching their expected.shouldFlag keywords; no expected impact on passing cases',
    requiredVerification: [
      're-run visible set; require non-regression',
      're-run holdout set; require non-regression',
      're-run clean controls; require zero new spurious flags',
    ],
  };
}

// Helper: extract clean-control samples from a runCaseSet result + the
// original case definitions, in the shape synthesizeAutoProposal wants.
// Pulls every case whose definition has `expected.controlNoDoctrineFlags`,
// carrying through pass/fail and the per-check breakdown so the proposer
// can spot which doctrines fired spuriously.
function extractCleanControlSamples(caseSetResult, caseDefs) {
  const byId = new Map((caseDefs || []).map((c) => [c.id, c]));
  const samples = [];
  for (const r of (caseSetResult && caseSetResult.results) || []) {
    const def = byId.get(r.caseId);
    if (!def || !def.expected || !def.expected.controlNoDoctrineFlags) continue;
    samples.push({
      caseId: r.caseId,
      description: def.description || '',
      pass: r.pass,
      checks: r.checks || [],
    });
  }
  return samples;
}

// Evaluate a candidate specialist against BOTH visible and holdout case
// sets in one pass.  Returns {visible, holdout, full}: each entry has
// the runCaseSet shape (total, passCount, failCount, passRate, results),
// plus `full` aggregates both sets so the promotion gate can use any
// combination.
//
// Anti-Goodhart contract: this is the EVALUATOR-side function.  The
// PROPOSER side (synthesizeAutoProposal) is required to receive only
// the `visible` slice of failures and cleanControlSamples — never the
// holdout slice.  Computing both metrics here is what the promotion
// gate reads to detect visible-up / holdout-down overfit.
function runVisibleAndHoldout(specialistId, { visibleCases, holdoutCases }, opts = {}) {
  const visible = runCaseSet(specialistId, visibleCases || [], opts);
  const holdout = runCaseSet(specialistId, holdoutCases || [], opts);
  const fullTotal = visible.total + holdout.total;
  const fullPass = visible.passCount + holdout.passCount;
  return {
    visible,
    holdout,
    full: {
      total: fullTotal,
      passCount: fullPass,
      failCount: fullTotal - fullPass,
      passRate: fullTotal ? fullPass / fullTotal : 0,
    },
  };
}

// Anti-Goodhart verdict — codifies the decision rule that the 0.19.0
// closed-loop demo applied by human judgment.  Given the four pass-rate
// scores (visible/holdout × before/after), decide whether to promote,
// revert, or hold.
//
// Rule (from §10 of the 2026-05-12 brainstorm + commit 915e0b6):
//   1. If holdout regressed by more than `holdoutRegressionMax` (relative)
//      → REVERT regardless of visible.  Holdout regression beats
//      visible improvement; that's the whole point of the split.
//   2. Else if FULL set improved → PROMOTE.
//   3. Else → HOLD (neither up nor down enough to act on).
//
// Defaults match the security/promotion-gate constants so this rule is
// consistent with the rest of the stack.
//
// Score inputs are pass rates in [0, 1].  Missing inputs default to 0
// (which makes "before" pessimistic and "after" pessimistic — the safe
// direction).  Pass them explicitly to avoid silent surprises.
function evaluateCycleVerdict({
  visibleBefore = 0,
  visibleAfter = 0,
  holdoutBefore = 0,
  holdoutAfter = 0,
  holdoutRegressionMax = 0.20,   // matches DEFAULT_THRESHOLDS.regressionRelMax
  fullImprovementMin = 0.01,     // 1pp on the combined set; tiny but non-zero
} = {}) {
  const relChange = (b, a) => {
    if (b === 0) return a === 0 ? 0 : (a > 0 ? Infinity : -Infinity);
    return (a - b) / Math.abs(b);
  };

  const visibleDelta = visibleAfter - visibleBefore;
  const holdoutDelta = holdoutAfter - holdoutBefore;
  const visibleRel = relChange(visibleBefore, visibleAfter);
  const holdoutRel = relChange(holdoutBefore, holdoutAfter);

  // Approximate "full" pass-rate as the average of visible + holdout.
  // (Exact full pass-rate requires the case counts — the caller has those
  // via runVisibleAndHoldout().full.passRate; pass `fullBefore`/`fullAfter`
  // if you have the exact number.  Otherwise we approximate.)
  const fullBefore = (visibleBefore + holdoutBefore) / 2;
  const fullAfter = (visibleAfter + holdoutAfter) / 2;
  const fullDelta = fullAfter - fullBefore;

  const criticalHoldoutRegression = -holdoutRel > holdoutRegressionMax;

  let verdict;
  let reason;
  if (criticalHoldoutRegression) {
    verdict = 'revert';
    reason = `Holdout regressed by ${(holdoutRel * 100).toFixed(1)}% (threshold: -${(holdoutRegressionMax * 100).toFixed(0)}%); anti-Goodhart rule rejects patch regardless of visible delta`;
  } else if (fullDelta >= fullImprovementMin) {
    verdict = 'promote';
    reason = `Full-set improved by ${(fullDelta * 100).toFixed(1)}pp without critical holdout regression; promote`;
  } else {
    verdict = 'hold';
    reason = `Full-set delta ${(fullDelta * 100).toFixed(1)}pp below ${(fullImprovementMin * 100).toFixed(1)}pp threshold; hold for more data or a better proposal`;
  }

  return {
    verdict,
    reason,
    deltas: {
      visible: Number(visibleDelta.toFixed(4)),
      holdout: Number(holdoutDelta.toFixed(4)),
      full: Number(fullDelta.toFixed(4)),
      visibleRel: Number.isFinite(visibleRel) ? Number(visibleRel.toFixed(4)) : null,
      holdoutRel: Number.isFinite(holdoutRel) ? Number(holdoutRel.toFixed(4)) : null,
    },
    criticalHoldoutRegression,
    thresholds: { holdoutRegressionMax, fullImprovementMin },
  };
}

// runFullCycle — single-call orchestrator that walks the full IL cycle
// end-to-end: eval(before) → basin → reflect → propose (gated by
// consensus) → apply → eval(after) → verdict → ledger.
//
// Designed for unattended scheduling: every step's status is recorded
// in the returned object so the operator (or a cron job) can inspect
// the full trace without re-running. Anti-Goodhart applies:
//   - The PROPOSER side sees ONLY visible failures + visible clean-
//     control samples. Never holdout.
//   - The EVALUATOR side sees visible + holdout and computes the
//     verdict against the holdout-regression threshold.
//   - The CONSENSUS GATE refuses to propose when the multi-perspective
//     reflection disagrees too much (low consensus = low-trust signal).
//
// Args:
//   specialistId — required
//   visibleCases / holdoutCases — eval case arrays (already split)
//   reflect — { llmProvider, lenses? } optional. If absent, skips
//     multi-perspective reflection and uses a synthetic reflection
//     stub (root cause = "eval cases failed: <ids>"). Useful for
//     CI / no-LLM runs.
//   consensusThreshold — minimum rootCauseConsensus to allow a
//     proposal. Default 0.5. Set to 0 to disable gating.
//   applyPatch — async (proposal, candidateBundle) → void. Caller's
//     responsibility to actually persist + re-register the specialist
//     so the AFTER eval picks up the new prompt. If omitted, cycle
//     stops at proposal-generated; AFTER scores equal BEFORE.
//   verdictThresholds — { holdoutRegressionMax, fullImprovementMin }
//     optional overrides.
//   dataDir — for the cycle ledger.
//   repoRoot, meridianPath — passed to runCaseSet for CLI invocation.
//
// Returns: { cycleId, steps[], before, after, basin, reflection,
//            proposal, patchApplied, verdict, ledgerEntry }.
async function runFullCycle({
  specialistId,
  visibleCases,
  holdoutCases,
  reflect = null,
  consensusThreshold = 0.5,
  applyPatch = null,
  verdictThresholds = {},
  dataDir,
  repoRoot,
  meridianPath,
  cycleId = null,
  // Dependency-injection seam — tests stub a custom evaluator to avoid
  // spawning real specialist CLIs. Production callers leave this null
  // and the runner uses the in-module runVisibleAndHoldout.
  _eval = null,
} = {}) {
  if (!specialistId) throw new Error('runFullCycle: specialistId required');
  if (!Array.isArray(visibleCases)) throw new Error('runFullCycle: visibleCases array required');
  if (!Array.isArray(holdoutCases)) holdoutCases = [];

  const evalImpl = typeof _eval === 'function' ? _eval : runVisibleAndHoldout;
  const startedAt = new Date().toISOString();
  const finalCycleId = cycleId || 'full-cycle-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const steps = [];
  const callOpts = { repoRoot, meridianPath };

  // Step 1: eval BEFORE.
  const before = evalImpl(specialistId, { visibleCases, holdoutCases }, callOpts);
  steps.push({ step: 'eval-before', visible: before.visible.passRate, holdout: before.holdout.passRate, full: before.full.passRate });

  // Step 2: build basin from visible failures (holdout NEVER seen by proposer).
  const visibleFailures = before.visible.results.filter((r) => !r.pass);
  const basin = visibleFailures.length > 0 ? buildBasinFromFailures(specialistId, visibleFailures) : null;
  steps.push({ step: 'basin', failureCount: visibleFailures.length });

  // Step 3: reflect (multi-perspective if llmProvider supplied).
  let reflection = null;
  if (basin) {
    if (reflect && reflect.llmProvider) {
      try {
        reflection = await reflectMultiPerspective(basin, basin.rawSamples || [], reflect.llmProvider, { lenses: reflect.lenses });
        steps.push({ step: 'reflect', consensus: reflection.agreement.rootCauseConsensus, perspectives: reflection.agreement.perspectiveCount });
      } catch (err) {
        steps.push({ step: 'reflect', error: err.message });
        reflection = null;
      }
    } else {
      // Synthetic reflection so the proposer has a root-cause string
      // but no LLM cost. Consensus is recorded as null (= "not measured").
      reflection = {
        merged: { rootCause: 'visible eval cases failed: ' + visibleFailures.map((f) => f.caseId).join(', '), multiPerspective: false },
        agreement: { rootCauseConsensus: null, perspectiveCount: 0 },
      };
      steps.push({ step: 'reflect', consensus: null, perspectives: 0, mode: 'synthetic' });
    }
  } else {
    steps.push({ step: 'reflect', skipped: 'no failures' });
  }

  // Step 4: consensus gate — refuse to propose if multi-perspective
  // reflection disagrees too much. Synthetic reflection (consensus
  // null) bypasses the gate.
  let proposal = null;
  let consensusOk = true;
  if (reflection && basin) {
    const conf = reflection.agreement.rootCauseConsensus;
    if (conf !== null && conf < consensusThreshold) {
      consensusOk = false;
      steps.push({ step: 'consensus-gate', decision: 'block', consensus: conf, threshold: consensusThreshold, reason: 'lenses disagree too much; refusing to propose' });
    } else {
      steps.push({ step: 'consensus-gate', decision: 'allow', consensus: conf, threshold: consensusThreshold });
    }
  }

  if (consensusOk && basin) {
    // Step 5: synthesize proposal. Pass clean-control samples from
    // VISIBLE only (not holdout) to enable contrastive vocabulary.
    const cleanControlSamples = extractCleanControlSamples(before.visible, visibleCases);
    proposal = synthesizeAutoProposal({
      specialistId,
      currentPrompt: null, // applyPatch is responsible for loading the bundle
      reflection,
      failures: visibleFailures,
      cleanControlSamples,
    });
    steps.push({ step: 'propose', proposalId: proposal.proposalId, kind: proposal.kind, keywordsAdded: (proposal.patch.keywordsAdded || []).length, avoidDoctrines: (proposal.patch.avoidDoctrines || []).length });
  }

  // Step 6: apply patch via operator callback (if supplied).
  let patchApplied = false;
  if (proposal && typeof applyPatch === 'function') {
    try {
      await applyPatch(proposal);
      patchApplied = true;
      steps.push({ step: 'apply-patch', applied: true });
    } catch (err) {
      steps.push({ step: 'apply-patch', applied: false, error: err.message });
    }
  } else if (proposal) {
    steps.push({ step: 'apply-patch', applied: false, reason: 'no applyPatch callback supplied' });
  }

  // Step 7: eval AFTER. If patch wasn't applied, after === before.
  const after = patchApplied
    ? evalImpl(specialistId, { visibleCases, holdoutCases }, callOpts)
    : before;
  steps.push({ step: 'eval-after', visible: after.visible.passRate, holdout: after.holdout.passRate, full: after.full.passRate });

  // Step 8: verdict.
  const verdict = evaluateCycleVerdict({
    visibleBefore: before.visible.passRate,
    visibleAfter: after.visible.passRate,
    holdoutBefore: before.holdout.passRate,
    holdoutAfter: after.holdout.passRate,
    ...verdictThresholds,
  });
  // Override verdict to 'hold-low-consensus' when proposer was blocked
  // by consensus gate (no proposal happened so deltas are zero).
  if (!consensusOk) verdict.verdict = 'hold-low-consensus';
  steps.push({ step: 'verdict', decision: verdict.verdict, reason: verdict.reason });

  // Step 9: ledger entry — full audit trail.
  const ledgerEntry = appendCycleEntry({
    cycleId: finalCycleId,
    specialistId,
    startedAt,
    finishedAt: new Date().toISOString(),
    visibleScoreBefore: before.visible.passRate,
    visibleScoreAfter: after.visible.passRate,
    holdoutScoreBefore: before.holdout.passRate,
    holdoutScoreAfter: after.holdout.passRate,
    fullScoreBefore: before.full.passRate,
    fullScoreAfter: after.full.passRate,
    reflectionRootCauses: reflection ? [reflection.merged && reflection.merged.rootCause].filter(Boolean) : [],
    reflectionConsensus: reflection ? reflection.agreement.rootCauseConsensus : null,
    proposalKind: proposal ? proposal.kind : null,
    proposalId: proposal ? proposal.proposalId : null,
    patchApplied,
    verdictDecision: verdict.verdict,
    gateDecision: verdict.verdict, // back-compat with earlier ledger schema
    criticalHoldoutRegression: verdict.criticalHoldoutRegression,
  }, { dataDir });

  return {
    cycleId: finalCycleId,
    specialistId,
    steps,
    before, after, basin, reflection, proposal, patchApplied, verdict,
    ledgerEntry: { sequence: ledgerEntry.sequence, entryHash: ledgerEntry.entryHash },
  };
}

// Canonical applyPatch wiring for the IL closed loop — feed this as
// the `applyPatch` opt to runFullCycle for the standard "auto-write
// sidecar + bump spec version" semantics. Operator callbacks that want
// dry-run / CI-only / alternative apply paths can substitute their own.
//
//   const applyPatchSidecar = async (proposal) => {
//     const previous = sidecar.readSidecar(specialistId) || '';
//     const nudge = previous + '\n' + proposal.patch.guidance;
//     const targetVersion = sidecar.bumpMinor(currentVersion);
//     sidecar.writeSidecar(specialistId, nudge, {
//       proposalId: proposal.proposalId, cycleId, targetVersion,
//     });
//     sidecar.rewriteVersionInSpec(sidecar.specPath(specialistId), targetVersion);
//   };
//
// The orchestrator (above) calls applyPatch BEFORE eval-after, so
// scoresAfter reflects the candidate prompt. On verdict='revert' the
// caller is responsible for clearing the sidecar — typically by
// chaining an evaluateCycleVerdict check after runFullCycle and
// invoking sidecar.clearSidecar(specialistId) on revert.
// (Duplicate runFullCycle body removed.  Canonical implementation is above.)

// Apply a proposal to the in-memory specialist bundle so we can run
// it. Returns a shallow-cloned bundle with the patched prompt.
function applyProposalToBundle(originalBundle, proposal) {
  const cloned = JSON.parse(JSON.stringify(originalBundle));
  if (proposal.kind === 'prompt_patch' && proposal.patch && proposal.patch.prompt) {
    cloned.promptTemplates = cloned.promptTemplates || {};
    cloned.promptTemplates.system = proposal.patch.prompt;
  }
  return cloned;
}

// Append a cycle entry to the ledger (hash-chained, like every other
// ledger in the stack).
function appendCycleEntry(payload, opts = {}) {
  const filePath = cycleLedgerPath(opts);
  ensureFile(filePath);
  const existing = readLedger(filePath);
  const previous = existing[existing.length - 1] || null;
  const entry = {
    sequence: existing.length + 1,
    previousHash: previous ? previous.entryHash : null,
    ...payload,
  };
  entry.entryHash = entryHash(entry);
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function listCycles(opts = {}) {
  const entries = readLedger(cycleLedgerPath(opts));
  if (opts.specialistId) return entries.filter((e) => e.specialistId === opts.specialistId);
  return entries;
}

function verifyCycleLedger(opts = {}) {
  const filePath = cycleLedgerPath(opts);
  if (!fs.existsSync(filePath)) return { ok: true, entries: 0, message: 'no_ledger_yet' };
  const entries = readLedger(filePath);
  let prev = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.sequence !== i + 1) return { ok: false, failedAt: i + 1, reason: 'sequence_gap' };
    if (e.previousHash !== (prev ? prev.entryHash : null)) return { ok: false, failedAt: i + 1, reason: 'previous_hash_mismatch' };
    if (entryHash(e) !== e.entryHash) return { ok: false, failedAt: i + 1, reason: 'entry_hash_mismatch' };
    prev = e;
  }
  return { ok: true, entries: entries.length, headHash: prev ? prev.entryHash : null };
}

module.exports = {
  EVAL_TEMPERATURE_DEFAULT,
  scoreModelOutput,
  runSingleCase,
  aggregateCaseRuns,
  runCaseSet,
  runVisibleAndHoldout,
  runFullCycle,
  buildBasinFromFailures,
  synthesizeAutoProposal,
  extractCleanControlSamples,
  applyProposalToBundle,
  evaluateCycleVerdict,
  appendCycleEntry,
  listCycles,
  verifyCycleLedger,
  cycleLedgerPath,
  // Re-exported so IL callers have one entry point.  trace-reflection.js
  // owns the implementation; cycle-runner just wires it into the IL flow.
  // Multi-perspective output's `.merged` shape matches the existing
  // `reflection` parameter contract of synthesizeAutoProposal — feed the
  // multi-perspective output directly in to get contrastive guidance +
  // lens-agreement metadata captured in the proposal.
  reflectMultiPerspective,
};
