'use strict';

// Trace Optimizer — VerificationRunnerPort (Slice 3).
//
// Slice 3 is the load-bearing one: it's what turns "we accumulate" into
// "we evolve." A reflection (Slice 1) + recommendation (Slice 2) is a
// candidate. Until something OBSERVES the patch actually applying without
// breaking anything, the doctrine (decision-1777317024151 Truth/Evidence/
// Promotion) forbids promotion. This module is that observation.
//
// MVP scope (honest — don't oversell):
//   - APPLY the proposed patch to a temp copy of the target file
//   - For code_edit: run `node --check` to confirm the result parses
//   - For doc_edit / prompt_edit / config_edit: confirm the before text
//     was found in the target and successfully replaced
//   - For unsupported kinds (guard_add, test_add, other): mark
//     'unsupported' rather than pretend
//   - Optionally rerun a focused test command when --run-tests is set
//   - NEVER modifies in-place; the temp copy lives under os.tmpdir()
//
// Out-of-MVP (Slice 3.1+):
//   - Whole-scenario rerun against the original failing handoff path
//   - Multi-file patches
//   - Patch-conflict-with-current-state diffs
//
// Hex placement: recall-cli-level adapter. Pure given inputs (file paths,
// patch object); does NOT call into engine ports. Tests can pass synthetic
// patches against tmp-dir fixtures with no LLM required.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const STATUS_APPLIED = 'applied';
const STATUS_APPLY_FAILED = 'apply_failed';
const STATUS_UNSUPPORTED = 'unsupported';
const STATUS_TARGET_MISSING = 'target_missing';
const STATUS_BEFORE_NOT_FOUND = 'before_not_found';
const STATUS_AFTER_NO_CHANGE = 'after_no_change';

const SUPPORTED_PATCH_KINDS = new Set([
  'doc_edit', 'prompt_edit', 'config_edit', 'code_edit',
]);

function shortId() {
  return crypto.randomBytes(6).toString('hex');
}

function tempCopyPath(originalAbsolutePath) {
  const base = path.basename(originalAbsolutePath);
  return path.join(os.tmpdir(), `trace-verify-${shortId()}-${base}`);
}

function resolveTarget(repoRoot, relPath) {
  if (!relPath) return '';
  return path.isAbsolute(relPath) ? relPath : path.resolve(repoRoot, relPath);
}

function runNodeSyntaxCheck(filePath) {
  try {
    const result = spawnSync(process.execPath, ['--check', filePath], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return {
      syntaxValid: result.status === 0,
      syntaxStderr: (result.stderr || '').slice(0, 500),
    };
  } catch (err) {
    return { syntaxValid: false, syntaxStderr: `spawn error: ${err.message}` };
  }
}

function runTestCommand(command, opts = {}) {
  if (!command) return null;
  const [bin, ...args] = command.split(/\s+/);
  try {
    const result = spawnSync(bin, args, {
      encoding: 'utf8',
      timeout: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 60_000,
      shell: process.platform === 'win32',
    });
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    // Best-effort: pull "Tests: X passed, Y failed" or jest summary.
    const passMatch = stdout.match(/(\d+)\s+passed/i);
    const failMatch = stdout.match(/(\d+)\s+failed/i);
    return {
      command,
      exitCode: result.status,
      passCount: passMatch ? Number(passMatch[1]) : null,
      failCount: failMatch ? Number(failMatch[1]) : 0,
      stdoutTail: stdout.slice(-400),
      stderrTail: stderr.slice(-400),
    };
  } catch (err) {
    return {
      command,
      exitCode: -1,
      passCount: null,
      failCount: null,
      stdoutTail: '',
      stderrTail: `spawn error: ${err.message}`,
    };
  }
}

/**
 * Verify a HarnessPatchRecommendation against its target file.
 *
 * @param {object} patch              From recommendPatch() — must have patchKind, target.file, change.before, change.after
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]    Resolves target.file relative paths; defaults to process.cwd()
 * @param {string} [opts.basinId]     Carried through onto the result for traceability
 * @param {string} [opts.runTests]    Shell command to rerun after apply (e.g. "npm test"); skipped if absent
 * @param {number} [opts.testTimeoutMs]
 * @returns {{ status, applied, syntaxValid, targetFile, tempCopy, notes, testsRun, verifiedAt, basinId, patchKind }} VerificationRun
 */
function verifyPatch(patch, opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const basinId = opts.basinId || '';
  const verifiedAt = new Date().toISOString();
  const patchKind = patch && patch.patchKind ? patch.patchKind : 'other';
  const targetRel = patch && patch.target && patch.target.file ? patch.target.file : '';
  const notes = [];

  // Unsupported kinds short-circuit.
  if (!SUPPORTED_PATCH_KINDS.has(patchKind)) {
    return {
      basinId,
      patchKind,
      status: STATUS_UNSUPPORTED,
      applied: false,
      syntaxValid: null,
      targetFile: targetRel,
      tempCopy: '',
      notes: [`patchKind="${patchKind}" not yet verifiable by Slice 3 MVP (supported: ${[...SUPPORTED_PATCH_KINDS].join(', ')})`],
      testsRun: null,
      verifiedAt,
    };
  }

  const targetAbs = resolveTarget(repoRoot, targetRel);

  if (!targetRel || !fs.existsSync(targetAbs)) {
    return {
      basinId,
      patchKind,
      status: STATUS_TARGET_MISSING,
      applied: false,
      syntaxValid: null,
      targetFile: targetRel,
      tempCopy: '',
      notes: [`Target file does not exist at ${targetAbs || '(empty)'}`],
      testsRun: null,
      verifiedAt,
    };
  }

  const original = fs.readFileSync(targetAbs, 'utf8');
  const before = patch.change && patch.change.before ? String(patch.change.before) : '';
  const after = patch.change && patch.change.after ? String(patch.change.after) : '';

  // Allow "additive" patches: an empty `before` means the recommendation
  // intends to APPEND `after` rather than replace anything.
  let patched;
  if (!before) {
    if (!after) {
      return {
        basinId, patchKind,
        status: STATUS_AFTER_NO_CHANGE,
        applied: false, syntaxValid: null,
        targetFile: targetRel, tempCopy: '',
        notes: ['Both change.before and change.after were empty; nothing to apply'],
        testsRun: null, verifiedAt,
      };
    }
    patched = original + (original.endsWith('\n') ? '' : '\n') + after + '\n';
    notes.push('Additive patch (empty change.before): appended change.after to end of target');
  } else {
    if (!original.includes(before)) {
      return {
        basinId, patchKind,
        status: STATUS_BEFORE_NOT_FOUND,
        applied: false, syntaxValid: null,
        targetFile: targetRel, tempCopy: '',
        notes: ['change.before string was not found in target file — patch is stale or target drifted'],
        testsRun: null, verifiedAt,
      };
    }
    patched = original.replace(before, after);
    if (patched === original) {
      return {
        basinId, patchKind,
        status: STATUS_AFTER_NO_CHANGE,
        applied: false, syntaxValid: null,
        targetFile: targetRel, tempCopy: '',
        notes: ['change.before and change.after produce identical text — nothing changed'],
        testsRun: null, verifiedAt,
      };
    }
  }

  const tempCopy = tempCopyPath(targetAbs);
  try {
    fs.writeFileSync(tempCopy, patched, 'utf8');
  } catch (err) {
    return {
      basinId, patchKind,
      status: STATUS_APPLY_FAILED,
      applied: false, syntaxValid: null,
      targetFile: targetRel, tempCopy,
      notes: [`Failed to write temp copy: ${err.message}`],
      testsRun: null, verifiedAt,
    };
  }

  let syntaxValid = null;
  if (patchKind === 'code_edit' && /\.(m?js|cjs)$/.test(targetAbs)) {
    const syntax = runNodeSyntaxCheck(tempCopy);
    syntaxValid = syntax.syntaxValid;
    if (!syntax.syntaxValid) {
      notes.push(`node --check failed on patched copy: ${syntax.syntaxStderr.trim()}`);
    }
  } else if (patchKind === 'code_edit') {
    notes.push(`code_edit targets non-JS file (${targetRel}); syntax check skipped`);
  }

  const testsRun = opts.runTests
    ? runTestCommand(opts.runTests, { timeoutMs: opts.testTimeoutMs })
    : null;

  return {
    basinId, patchKind,
    status: STATUS_APPLIED,
    applied: true,
    syntaxValid,
    targetFile: targetRel,
    tempCopy,
    notes,
    testsRun,
    verifiedAt,
  };
}

module.exports = {
  STATUS_APPLIED,
  STATUS_APPLY_FAILED,
  STATUS_UNSUPPORTED,
  STATUS_TARGET_MISSING,
  STATUS_BEFORE_NOT_FOUND,
  STATUS_AFTER_NO_CHANGE,
  SUPPORTED_PATCH_KINDS,
  verifyPatch,
  runNodeSyntaxCheck,
  runTestCommand,
};
