#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const nodeBin = process.execPath;
const jestBin = path.join(root, 'node_modules', 'jest', 'bin', 'jest.js');

function usage() {
  return [
    'Usage: node scripts/export-public-mirror.js --output-dir <path> [options]',
    '',
    'Options:',
    '  --output-dir <path>   Fresh directory that receives the public mirror',
    '  --public-only         Export only public files, excluding experimental lab surfaces',
    '  --skip-tests          Skip the targeted release-scope/readiness test set',
    '  --json                Print a JSON summary',
    '  --help                Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {
    outputDir: '',
    publicOnly: false,
    skipTests: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { ...opts, help: true };
    if (arg === '--output-dir') {
      opts.outputDir = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--public-only') {
      opts.publicOnly = true;
    } else if (arg === '--skip-tests') {
      opts.skipTests = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function runStep(name, command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: opts.cwd || root,
    encoding: 'utf8',
    // Default Node maxBuffer is 1MB. release-scope --json on this repo is
    // ~5-10MB once it enumerates ~120k classified paths; without this bump
    // the mirror export dies with ENOBUFS. 128MB is overkill-safe.
    maxBuffer: 128 * 1024 * 1024,
    env: {
      ...process.env,
      ...(opts.env || {}),
    },
  });
  const step = {
    name,
    command: [command, ...args].join(' '),
    status: result.status,
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? result.error.message : '',
  };
  if (!step.ok) {
    const detail = step.error || step.stderr || step.stdout || `exit ${step.status}`;
    const err = new Error(`${name} failed: ${detail}`);
    err.step = step;
    throw err;
  }
  return step;
}

function assertFreshOutputDir(outputDir) {
  if (!outputDir) throw new Error('--output-dir is required');
  const resolved = path.resolve(outputDir);
  const relative = path.relative(root, resolved);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error('Output directory must be outside the source checkout.');
  }
  if (fs.existsSync(resolved) && fs.readdirSync(resolved).length > 0) {
    throw new Error('Output directory already exists and is not empty. Use a fresh mirror directory.');
  }
  return resolved;
}

function jsonFromStep(step) {
  return JSON.parse(step.stdout);
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(usage());
    return { ok: true, help: true };
  }

  const outputDir = assertFreshOutputDir(opts.outputDir);
  const steps = [];

  if (!opts.skipTests) {
    steps.push(runStep('targeted-tests', nodeBin, [
      jestBin,
      '--verbose',
      '--runInBand',
      'test/open-source-readiness.test.js',
      'test/release-scope.test.js',
      'test/core-feature-catalog.test.js',
    ]));
  }

  const readiness = runStep('limited-public-readiness', nodeBin, [
    'bin/meridian.js',
    'open-source',
    'readiness',
    '--stage',
    'limited-public',
    '--release-mode',
    'npm',
    '--json',
  ]);
  steps.push(readiness);

  const releaseScope = runStep('release-scope', nodeBin, [
    'bin/meridian.js',
    'open-source',
    'release-scope',
    '--release-mode',
    'npm',
    '--json',
  ]);
  steps.push(releaseScope);

  const exportArgs = [
    'bin/meridian.js',
    'open-source',
    'export-scope',
    '--output-dir',
    outputDir,
    '--json',
  ];
  if (opts.publicOnly) exportArgs.push('--public-only');
  const exported = runStep('export-scope', nodeBin, exportArgs);
  steps.push(exported);

  // release-audit: the public-push-discipline + topology HARD RULE gate.
  // Refuses to declare the export clean if any HARD-RULE pattern hits.
  // Patterns come from ~/.recall/security/release-audit-rules.json (machine-
  // local; never committed). If that file is missing, audit exits 2 and the
  // export aborts — silent skip is not possible.
  const audit = runStep('release-audit', nodeBin, [
    path.join(root, 'scripts', 'release-audit.js'),
    outputDir,
    '--json',
  ]);
  steps.push(audit);

  const readinessBody = jsonFromStep(readiness);
  const releaseScopeBody = jsonFromStep(releaseScope);
  const exportBody = jsonFromStep(exported);
  const auditBody = jsonFromStep(audit);
  const summary = {
    ok: true,
    outputDir,
    publicOnly: opts.publicOnly,
    testsRun: !opts.skipTests,
    readiness: readinessBody.summary,
    releaseScope: releaseScopeBody.summary,
    export: {
      copied: exportBody.counts ? exportBody.counts.written : exportBody.written,
      selected: exportBody.counts ? exportBody.counts.selected : exportBody.selected,
      manifestPath: exportBody.manifestPath,
    },
    audit: {
      ok: auditBody.ok,
      hits: auditBody.hitCount,
      rules: auditBody.ruleCount,
      fileCount: auditBody.fileCount,
    },
    steps: steps.map((step) => ({
      name: step.name,
      status: step.status,
      ok: step.ok,
    })),
  };

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Public mirror exported: ${outputDir}`);
    console.log(`Readiness: ${summary.readiness.status} (${summary.readiness.blockerCount} blockers, ${summary.readiness.warnCount} warnings)`);
    console.log(`Release scope: ${releaseScopeBody.status} (${summary.releaseScope.public} public, ${summary.releaseScope.experimental} experimental, ${summary.releaseScope.excluded} excluded)`);
    console.log(`Copied: ${summary.export.copied}`);
    console.log(`Manifest: ${summary.export.manifestPath}`);
  }
  return summary;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    if (err.step && err.step.stderr) console.error(err.step.stderr);
    process.exitCode = 1;
  }
}

module.exports = {
  assertFreshOutputDir,
  main,
  parseArgs,
  runStep,
};
