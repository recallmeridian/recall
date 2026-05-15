'use strict';

// open-source-readiness: allow-private-path-fixtures

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Command } = require('commander');

const {
  classifyPath,
  evaluateReleaseScope,
  exportReleaseScope,
} = require('../lib/release-scope');
const registerOpenSourceCommand = require('../lib/commands/open-source');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recall-release-scope-'));
}

function writeFile(root, relativePath, text = 'x\n') {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

function makeProgram() {
  const program = new Command();
  program.exitOverride();
  let stdout = '';
  let stderr = '';
  program.configureOutput({
    writeOut(text) { stdout += text; },
    writeErr(text) { stderr += text; },
  });
  registerOpenSourceCommand(program);
  return {
    program,
    output() {
      return { stdout, stderr };
    },
  };
}

describe('release scope', () => {
  let dir;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('classifies public, experimental, excluded, and unspecified paths', () => {
    expect(classifyPath('README.md')).toBe('public');
    expect(classifyPath('.gitlab-ci.yml')).toBe('public');
    expect(classifyPath('release-scope-export.json')).toBe('public');
    expect(classifyPath('lib/welcome.js')).toBe('public');
    expect(classifyPath('scripts/export-public-mirror.js')).toBe('public');
    expect(classifyPath('docs/plans/research-extractions/2026-05-03-camel-capability-security-extraction.md')).toBe('public');
    expect(classifyPath('docs/plans/private-roadmap.md')).toBe('excluded');
    expect(classifyPath('lib/commands/intelligence.js')).toBe('experimental');
    expect(classifyPath('data/imports/research.json')).toBe('excluded');
    expect(classifyPath('downloads/research/paper.pdf')).toBe('excluded');
    expect(classifyPath('accounting-platform/README.md')).toBe('excluded');
    expect(classifyPath('docs/security/owasp-coverage-matrix.md')).toBe('public');
    expect(classifyPath('docs/architecture/geomorphological-security-core.md')).toBe('excluded');
    expect(classifyPath('notes/private.md')).toBe('unspecified');
  });

  test('reports release features and excluded research surfaces', () => {
    writeFile(dir, 'README.md');
    writeFile(dir, 'lib/welcome.js');
    writeFile(dir, 'lib/commands/intelligence.js');
    writeFile(dir, 'data/imports/research.json');
    writeFile(dir, 'notes/private.md');

    const report = evaluateReleaseScope({
      root: dir,
      now: '2026-05-05T00:00:00.000Z',
    });

    expect(report.status).toBe('ready_with_scope_notes');
    expect(report.summary).toMatchObject({
      public: 2,
      experimental: 1,
      excluded: 1,
      unspecified: 1,
    });
    expect(report.publicFeatures.map((feature) => feature.id)).toEqual(expect.arrayContaining([
      'welcome-flow',
      'history-import',
    ]));
    expect(report.nonReleaseSurfaces.map((surface) => surface.id)).toContain('raw-research-corpora');
    expect(report.findings.find((finding) => finding.id === 'unspecified-release-scope')).toMatchObject({
      severity: 'warn',
    });
  });

  test('blocks when whole repo public release would include excluded surfaces', () => {
    writeFile(dir, 'README.md');
    writeFile(dir, 'data/imports/private-research.json');

    const report = evaluateReleaseScope({
      root: dir,
      requireWholeRepoPublic: true,
    });

    expect(report.status).toBe('blocked');
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'whole-repo-release-includes-excluded-surfaces',
        severity: 'blocker',
      }),
    ]));
  });

  test('open-source release-scope command prints JSON and exits on whole-repo blocker', async () => {
    writeFile(dir, 'README.md');
    writeFile(dir, 'data/imports/private-research.json');
    const { program } = makeProgram();
    const logs = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((text) => {
      logs.push(text);
    });

    let thrown;
    try {
      await program.parseAsync([
        'node',
        'recall',
        'open-source',
        'release-scope',
        '--root',
        dir,
        '--require-whole-repo-public',
        '--json',
      ]);
    } catch (err) {
      thrown = err;
    } finally {
      spy.mockRestore();
    }

    expect(thrown).toBeUndefined();
    expect(process.exitCode).toBe(1);
    const report = JSON.parse(logs.join('\n'));
    expect(report.status).toBe('blocked');
    process.exitCode = undefined;
  });

  test('exports public and experimental scope without excluded userland', () => {
    const outputDir = tempDir();
    try {
      writeFile(dir, 'README.md', '# Recall\n');
      writeFile(dir, 'lib/welcome.js', 'module.exports = {};\n');
      writeFile(dir, 'lib/commands/intelligence.js', 'module.exports = () => {};\n');
      writeFile(dir, 'docs/agent-handoffs/private.json', '{"private":true}\n');
      writeFile(dir, 'data/imports/private-research.json', '{}\n');

      const result = exportReleaseScope({
        root: dir,
        outputDir,
        now: '2026-05-08T00:00:00.000Z',
      });

      expect(result.dryRun).toBe(false);
      expect(result.counts.selected).toBe(3);
      expect(fs.existsSync(path.join(outputDir, 'README.md'))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, 'lib', 'welcome.js'))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, 'lib', 'commands', 'intelligence.js'))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, 'docs', 'agent-handoffs', 'private.json'))).toBe(false);
      expect(fs.existsSync(path.join(outputDir, 'data', 'imports', 'private-research.json'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(outputDir, 'release-scope-export.json'), 'utf8'))).toMatchObject({
        schemaVersion: 'recall_release_scope_export/v1',
        sourceRoot: '<SOURCE_ROOT>',
        includeExperimental: true,
        counts: {
          copied: 3,
        },
      });
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test('open-source export-scope command supports dry-run public-only JSON', async () => {
    writeFile(dir, 'README.md');
    writeFile(dir, 'lib/commands/intelligence.js');
    const outputDir = path.join(os.tmpdir(), `recall-public-mirror-${Date.now()}`);
    const { program } = makeProgram();
    const logs = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((text) => {
      logs.push(text);
    });

    try {
      await program.parseAsync([
        'node',
        'recall',
        'open-source',
        'export-scope',
        '--root',
        dir,
        '--output-dir',
        outputDir,
        '--public-only',
        '--dry-run',
        '--json',
      ]);
    } finally {
      spy.mockRestore();
      fs.rmSync(outputDir, { recursive: true, force: true });
    }

    const report = JSON.parse(logs.join('\n'));
    expect(report.dryRun).toBe(true);
    expect(report.includeExperimental).toBe(false);
    expect(report.counts.selected).toBe(1);
    expect(report.selectedFiles).toEqual(['README.md']);
    expect(fs.existsSync(outputDir)).toBe(false);
  });
});
