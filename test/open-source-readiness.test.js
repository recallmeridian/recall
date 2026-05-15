'use strict';

// open-source-readiness: allow-private-path-fixtures

const fs = require('fs');
const os = require('os');
const path = require('path');
const { evaluateOpenSourceReadiness } = require('../lib/open-source-readiness');
const registerOpenSourceCommand = require('../lib/commands/open-source');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recall-open-source-readiness-'));
}

function writeFile(root, relativePath, text) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

function minimalPackage() {
  return JSON.stringify({
    name: 'recall-cli',
    version: '0.1.0',
    license: 'Apache-2.0',
    bin: {
      recall: 'bin/meridian.js',
      meridian: 'bin/meridian.js',
    },
  }, null, 2);
}

function minimalPublishablePackage() {
  const pkg = JSON.parse(minimalPackage());
  pkg.files = [
    'bin/',
    'lib/',
    'README.md',
    'LICENSE',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'package.json',
  ];
  return JSON.stringify(pkg, null, 2);
}

function makeProgram() {
  const { Command } = require('commander');
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut() {},
    writeErr() {},
  });
  registerOpenSourceCommand(program);
  return program;
}

describe('open source readiness gate', () => {
  let dir;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('blocks private alpha when README lacks outsider workflow sections', () => {
    writeFile(dir, 'README.md', '# recall-cli\n');
    writeFile(dir, 'LICENSE', 'Apache-2.0');
    writeFile(dir, 'package.json', minimalPackage());

    const report = evaluateOpenSourceReadiness({ root: dir, stage: 'private-alpha' });

    expect(report.summary.status).toBe('blocked');
    expect(report.findings.map((finding) => finding.id)).toEqual(expect.arrayContaining([
      'readme-what-this-is',
      'readme-first-workflow',
      'readme-core-concepts',
      'readme-not-ready',
    ]));
  });

  test('treats governance docs as public blockers but private-alpha warnings', () => {
    writeFile(dir, 'README.md', [
      '# recall-cli',
      '## What this project is',
      '## First useful workflow',
      '## Core concepts',
      '## What this is not ready for',
    ].join('\n'));
    writeFile(dir, 'LICENSE', 'Apache-2.0');
    writeFile(dir, 'package.json', minimalPackage());

    const privateReport = evaluateOpenSourceReadiness({ root: dir, stage: 'private-alpha' });
    const publicReport = evaluateOpenSourceReadiness({ root: dir, stage: 'limited-public' });

    expect(privateReport.summary.blockerCount).toBe(0);
    expect(privateReport.findings.find((finding) => finding.id === 'contributing-missing').severity).toBe('warn');
    expect(publicReport.summary.status).toBe('blocked');
    expect(publicReport.findings.find((finding) => finding.id === 'contributing-missing').severity).toBe('blocker');
  });

  test('blocks active release surface references to OneDrive and Downloads paths', () => {
    writeFile(dir, 'README.md', [
      '# recall-cli',
      '## What this project is',
      '## First useful workflow',
      'Use C:\\Users\\jesse\\OneDrive\\Desktop\\recall-cli',
      '## Core concepts',
      '## What this is not ready for',
    ].join('\n'));
    writeFile(dir, 'LICENSE', 'Apache-2.0');
    writeFile(dir, 'package.json', minimalPackage());
    writeFile(dir, 'lib/example.js', 'const fixture = "C:\\\\Users\\\\jesse\\\\Downloads\\\\secret.json";\n');

    const report = evaluateOpenSourceReadiness({ root: dir, stage: 'private-alpha' });

    expect(report.summary.status).toBe('blocked');
    expect(report.findings.some((finding) => finding.id.startsWith('onedrive-path-reference:README-md'))).toBe(true);
    expect(report.findings.some((finding) => finding.id.startsWith('downloads-path-reference:lib-example-js'))).toBe(true);
  });

  test('does not treat safety blocklist literals as active private paths', () => {
    writeFile(dir, 'README.md', [
      '# recall-cli',
      '## What this project is',
      '## First useful workflow',
      '## Core concepts',
      '## What this is not ready for',
    ].join('\n'));
    writeFile(dir, 'LICENSE', 'Apache-2.0');
    writeFile(dir, 'package.json', minimalPackage());
    writeFile(dir, 'lib/path-safety.js', [
      "const blocked = ['\\\\onedrive\\\\', '/onedrive/', '\\\\downloads\\\\', '/downloads/'];",
      "module.exports = blocked;",
    ].join('\n'));

    const report = evaluateOpenSourceReadiness({ root: dir, stage: 'private-alpha' });

    expect(report.summary.status).toBe('ready');
    expect(report.findings.filter((finding) => finding.file === 'lib\\path-safety.js')).toEqual([]);
  });

  test('allows historical path mentions outside active release surface as warnings', () => {
    writeFile(dir, 'README.md', [
      '# recall-cli',
      '## What this project is',
      '## First useful workflow',
      '## Core concepts',
      '## What this is not ready for',
    ].join('\n'));
    writeFile(dir, 'LICENSE', 'Apache-2.0');
    writeFile(dir, 'package.json', minimalPackage());
    writeFile(dir, 'docs/history.md', 'Old path: C:\\Users\\jesse\\OneDrive\\Desktop\\old\n');

    const report = evaluateOpenSourceReadiness({ root: dir, stage: 'private-alpha' });

    expect(report.summary.status).toBe('ready');
    expect(report.findings.find((finding) => finding.file === 'docs\\history.md').severity).toBe('warn');
  });

  test('excludes local-only Recall memory and import artifacts from public path warning noise', () => {
    writeFile(dir, 'README.md', [
      '# recall-cli',
      '## What this project is',
      '## First useful workflow',
      '## Core concepts',
      '## What this is not ready for',
    ].join('\n'));
    writeFile(dir, 'LICENSE', 'Apache-2.0');
    writeFile(dir, 'package.json', minimalPackage());
    writeFile(dir, '.recall/brainstorming/session/source-pack.json', '{"path":"C:\\\\Users\\\\jesse\\\\Desktop\\\\recall-cli"}\n');
    writeFile(dir, '.vscode/settings.json', '{"path":"C:\\\\Users\\\\jesse\\\\Desktop\\\\recall-cli"}\n');
    writeFile(dir, 'data/imports/research.json', '{"download":"C:\\\\Users\\\\jesse\\\\Downloads\\\\paper.pdf"}\n');
    writeFile(dir, 'data/local-inputs/README.md', 'Use local path C:\\Users\\jesse\\Desktop\\recall-cli\n');
    writeFile(dir, '.codex_research_bundle.txt', 'C:\\Users\\jesse\\Downloads\\bundle.txt\n');

    const report = evaluateOpenSourceReadiness({ root: dir, stage: 'private-alpha' });

    expect(report.summary.status).toBe('ready');
    expect(report.findings.filter((finding) => finding.title.includes('path reference'))).toEqual([]);
  });

  test('blocks limited public packaging when dependencies resolve from local file paths', () => {
    writeFile(dir, 'README.md', [
      '# recall-cli',
      '## What this project is',
      '## First useful workflow',
      '## Core concepts',
      '## What this is not ready for',
    ].join('\n'));
    writeFile(dir, 'LICENSE', 'Apache-2.0');
    writeFile(dir, 'CONTRIBUTING.md', 'Contribute safely.\n');
    writeFile(dir, 'SECURITY.md', 'Report security issues privately.\n');
    const pkg = JSON.parse(minimalPublishablePackage());
    pkg.dependencies = {
      '@meridian/core': 'file:../recall-commons/packages/core',
    };
    writeFile(dir, 'package.json', JSON.stringify(pkg, null, 2));

    const report = evaluateOpenSourceReadiness({ root: dir, stage: 'limited-public' });

    expect(report.summary.status).toBe('blocked');
    expect(report.findings.find((finding) => finding.id === 'package-local-dependency:-meridian-core')).toMatchObject({
      severity: 'blocker',
      file: 'package.json',
    });
  });

  test('allows explicit source-only limited public mode when workspace setup is documented', () => {
    writeFile(dir, 'README.md', [
      '# recall-cli',
      '## What this project is',
      '## First useful workflow',
      '## Core concepts',
      '## What this is not ready for',
    ].join('\n'));
    writeFile(dir, 'LICENSE', 'Apache-2.0');
    writeFile(dir, 'CONTRIBUTING.md', 'Contribute safely.\n');
    writeFile(dir, 'SECURITY.md', 'Report security issues privately.\n');
    writeFile(dir, 'docs/setup/source-only-release.md', 'Clone recall-cli and recall-commons as sibling local checkouts.\n');
    const pkg = JSON.parse(minimalPackage());
    pkg.dependencies = {
      '@meridian/core': 'file:../recall-commons/packages/core',
    };
    writeFile(dir, 'package.json', JSON.stringify(pkg, null, 2));

    const report = evaluateOpenSourceReadiness({
      root: dir,
      stage: 'limited-public',
      releaseMode: 'source',
    });

    expect(report.summary.status).toBe('ready');
    expect(report.releaseMode).toBe('source');
    expect(report.findings.find((finding) => finding.id === 'package-local-dependency:-meridian-core')).toMatchObject({
      severity: 'warn',
      file: 'package.json',
    });
  });

  test('blocks source-only limited public mode without setup documentation', () => {
    writeFile(dir, 'README.md', [
      '# recall-cli',
      '## What this project is',
      '## First useful workflow',
      '## Core concepts',
      '## What this is not ready for',
    ].join('\n'));
    writeFile(dir, 'LICENSE', 'Apache-2.0');
    writeFile(dir, 'CONTRIBUTING.md', 'Contribute safely.\n');
    writeFile(dir, 'SECURITY.md', 'Report security issues privately.\n');
    writeFile(dir, 'package.json', minimalPackage());

    const report = evaluateOpenSourceReadiness({
      root: dir,
      stage: 'limited-public',
      releaseMode: 'source',
    });

    expect(report.summary.status).toBe('blocked');
    expect(report.findings.find((finding) => finding.id === 'source-only-release-doc-missing')).toMatchObject({
      severity: 'blocker',
      file: 'docs/setup/source-only-release.md',
    });
  });

  test('outsider-packet command writes transcript prompts for a first outsider', () => {
    writeFile(dir, 'README.md', [
      '# recall-cli',
      '## What this project is',
      '## First useful workflow',
      '## Core concepts',
      '## What this is not ready for',
      '## Open Source Readiness',
      '## Source-only setup',
    ].join('\n'));
    writeFile(dir, 'LICENSE', 'Apache-2.0');
    writeFile(dir, 'CONTRIBUTING.md', 'Contribute safely.\n');
    writeFile(dir, 'GOVERNANCE.md', 'Govern safely.\n');
    writeFile(dir, 'SECURITY.md', 'Report security issues privately.\n');
    writeFile(dir, 'package.json', minimalPackage());
    const outputDir = path.join(dir, '.codex-tmp', 'outsider-trials', 'tester');
    const program = makeProgram();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      program.parse([
        'node',
        'meridian',
        'open-source',
        'outsider-packet',
        '--root',
        dir,
        '--outsider-id',
        'tester',
        '--json',
      ]);
    } finally {
      logSpy.mockRestore();
    }

    expect(fs.existsSync(path.join(outputDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'transcript.json'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'transcript-answers.md'))).toBe(true);
    const transcript = JSON.parse(fs.readFileSync(path.join(outputDir, 'transcript.json'), 'utf8'));
    expect(transcript.outsiderId).toBe('tester');
    expect(transcript.answers.map((answer) => answer.checkpointId)).toEqual(expect.arrayContaining([
      'purpose',
      'trust-boundary',
    ]));
  });
});
