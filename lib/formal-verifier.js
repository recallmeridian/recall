'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GROUNDING_REFS = [
  'alphaproof-2025-formal-math-rl',
  'mathliblemma-2026-folklore-lemma-generation',
  'lemma-mining-hol-light-2013',
  'learning-assisted-theorem-proving-2014',
];

const ADAPTERS = new Set(['fake-lean', 'lean']);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeAdapter(value) {
  return String(value || 'fake-lean').trim().toLowerCase();
}

function clean(value) {
  return String(value || '').trim();
}

function hasFormalShape(statement) {
  return /^(theorem|lemma|example)\b/.test(clean(statement));
}

function fakeLeanCheck({ statement, proof }) {
  const text = `${statement}\n${proof}`;
  if (/\b(sorry|admit)\b/.test(text)) {
    return {
      passed: false,
      reason: 'proof_contains_placeholder',
      stderr: 'fake-lean rejected placeholder proof token.',
    };
  }
  if (/--\s*recall-pass\b/.test(text)) {
    return {
      passed: true,
      stdout: 'fake-lean accepted recall-pass fixture marker.',
    };
  }
  if (/\bTrue\b/.test(statement) && /\bby\s+trivial\b/.test(proof)) {
    return {
      passed: true,
      stdout: 'fake-lean accepted trivial proof fixture.',
    };
  }
  return {
    passed: false,
    reason: 'proof_did_not_typecheck',
    stderr: 'fake-lean could not match the proof to the formal statement.',
  };
}

function defaultCommandRunner(command, args = [], opts = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs,
    windowsHide: true,
  });
}

function commandOk(result) {
  return result && !result.error && result.status === 0;
}

function normalizeRunResult(result = {}) {
  return {
    status: Number.isInteger(result.status) ? result.status : (result.error ? 1 : 0),
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || result.error?.message || ''),
    error: result.error || null,
  };
}

function resolveLeanCommand(input = {}, opts = {}) {
  const runner = opts.commandRunner || defaultCommandRunner;
  const timeoutMs = Number(opts.timeoutMs || input.timeoutMs || 5000);
  const explicit = clean(opts.leanCommand || input.leanCommand || process.env.RECALL_LEAN_COMMAND);
  if (explicit) {
    return {
      command: explicit,
      argsPrefix: [],
      mode: 'explicit',
      available: commandOk(normalizeRunResult(runner(explicit, ['--version'], { timeoutMs }))),
    };
  }
  const lake = normalizeRunResult(runner('lake', ['--version'], { timeoutMs }));
  if (commandOk(lake)) {
    return {
      command: 'lake',
      argsPrefix: ['env', 'lean'],
      mode: 'lake-env-lean',
      available: true,
      version: clean(lake.stdout || lake.stderr),
    };
  }
  const lean = normalizeRunResult(runner('lean', ['--version'], { timeoutMs }));
  if (commandOk(lean)) {
    return {
      command: 'lean',
      argsPrefix: [],
      mode: 'lean',
      available: true,
      version: clean(lean.stdout || lean.stderr),
    };
  }
  return {
    command: 'lean',
    argsPrefix: [],
    mode: 'lean',
    available: false,
    version: '',
  };
}

function discoverVerifierAdapters(opts = {}) {
  const lean = resolveLeanCommand({}, opts);
  return [
    {
      adapter: 'fake-lean',
      available: true,
      mode: 'deterministic-fixture',
    },
    {
      adapter: 'lean',
      available: lean.available,
      mode: lean.mode,
      command: lean.command,
      version: lean.version || '',
    },
  ];
}

function leanCheck({ statement, proof, input, opts }) {
  const timeoutMs = Number(opts.timeoutMs !== undefined ? opts.timeoutMs : input.timeoutMs || 5000);
  const runner = opts.commandRunner || defaultCommandRunner;
  const resolved = resolveLeanCommand(input, { ...opts, timeoutMs, commandRunner: runner });
  if (!resolved.available) {
    return {
      passed: false,
      reason: 'lean_not_available',
      stderr: 'Lean executable was not found. Install Lean or pass leanCommand.',
      adapterDetails: resolved,
    };
  }

  const tempRoot = opts.tempDir || os.tmpdir();
  const dir = fs.mkdtempSync(path.join(tempRoot, 'recall-lean-'));
  const filePath = path.join(dir, 'claim.lean');
  const fileText = `${statement}\n${proof}\n`;
  fs.writeFileSync(filePath, fileText, 'utf8');
  const args = [...resolved.argsPrefix, filePath];
  const result = normalizeRunResult(runner(resolved.command, args, { timeoutMs, cwd: opts.cwd || process.cwd() }));
  const versionResult = normalizeRunResult(runner(resolved.command, [...resolved.argsPrefix, '--version'], { timeoutMs, cwd: opts.cwd || process.cwd() }));
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    passed: commandOk(result),
    reason: commandOk(result) ? '' : 'lean_typecheck_failed',
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
    adapterDetails: {
      ...resolved,
      version: clean(versionResult.stdout || versionResult.stderr || resolved.version),
      fileSha256: sha256(fileText),
    },
  };
}

function verifyFormalClaim(input = {}, opts = {}) {
  const adapter = normalizeAdapter(opts.adapter || input.adapter);
  const statement = clean(input.statement || input.formalStatement);
  const proof = clean(input.proof || input.proofText);
  const timeoutValue = opts.timeoutMs !== undefined ? opts.timeoutMs : input.timeoutMs;
  const timeoutMs = Number(timeoutValue !== undefined ? timeoutValue : 5000);
  const issues = [];

  if (!ADAPTERS.has(adapter)) issues.push('unknown_verifier_adapter');
  if (!statement) issues.push('missing_formal_statement');
  if (statement && !hasFormalShape(statement)) issues.push('invalid_formal_statement_shape');
  if (!proof) issues.push('missing_proof_artifact');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) issues.push('invalid_timeout');

  let adapterResult = {
    passed: false,
    reason: issues[0] || 'not_run',
  };
  if (issues.length === 0) {
    adapterResult = adapter === 'lean'
      ? leanCheck({ statement, proof, input, opts: { ...opts, timeoutMs } })
      : fakeLeanCheck({ statement, proof });
  }

  const runHash = sha256(JSON.stringify({
    adapter,
    statement,
    proof,
    adapterResult,
  }));
  const proofHash = sha256(proof);
  const passed = issues.length === 0 && adapterResult.passed === true;
  const evidenceTypes = passed
    ? ['formal_statement', 'verifier_run', 'proof_artifact']
    : ['formal_statement', 'verifier_run'].filter((type) => type !== 'formal_statement' || statement);

  return {
    entryType: 'verifier_result',
    adapter,
    language: input.language || 'lean',
    status: passed ? 'verified' : 'rejected',
    passed,
    issues: [
      ...issues,
      ...(adapterResult.passed === false && adapterResult.reason && !issues.includes(adapterResult.reason)
        ? [adapterResult.reason]
        : []),
    ],
    formalStatement: statement,
    verifierRun: {
      id: `verifier://${adapter}/${runHash.slice(0, 16)}`,
      adapter,
      timeoutMs,
      exitCode: adapterResult.exitCode !== undefined ? adapterResult.exitCode : (passed ? 0 : 1),
      stdout: adapterResult.stdout || '',
      stderr: adapterResult.stderr || '',
      adapterDetails: adapterResult.adapterDetails || {},
    },
    proofArtifact: proof ? {
      ref: input.proofArtifactRef || `proof://sha256/${proofHash}`,
      sha256: proofHash,
      fileSha256: adapterResult.adapterDetails?.fileSha256 || '',
    } : null,
    evidenceTypes,
    promotionDecision: passed ? 'verified_claim' : 'blocked_pending_verification',
    groundingRefs: GROUNDING_REFS,
  };
}

module.exports = {
  GROUNDING_REFS,
  discoverVerifierAdapters,
  verifyFormalClaim,
};
