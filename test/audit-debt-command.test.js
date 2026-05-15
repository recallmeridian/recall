'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Command } = require('commander');
const registerAuditDebt = require('../lib/commands/audit-debt');
const cliConfig = require('../lib/cli-config');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recall-audit-debt-command-'));
}

async function runAuditDebt(args) {
  const program = new Command();
  program.exitOverride();
  const logs = [];
  const errors = [];
  program.configureOutput({
    writeOut(value) {
      logs.push(String(value).trimEnd());
    },
    writeErr(value) {
      errors.push(String(value).trimEnd());
    },
  });
  registerAuditDebt(program);

  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  console.log = (value = '') => logs.push(String(value));
  console.error = (value = '') => errors.push(String(value));
  process.exitCode = undefined;

  try {
    await program.parseAsync(['node', 'test', ...args]);
    return {
      stdout: logs.join('\n'),
      stderr: errors.join('\n'),
      exitCode: process.exitCode || 0,
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExitCode;
  }
}

describe('audit-debt command', () => {
  let dir;
  let originalMeridianData;
  let originalMeridianDataDir;

  beforeEach(() => {
    dir = tempDir();
    originalMeridianData = process.env.MERIDIAN_DATA;
    originalMeridianDataDir = process.env.MERIDIAN_DATA_DIR;
    delete process.env.MERIDIAN_DATA;
    process.env.MERIDIAN_DATA_DIR = path.join(dir, 'data');
  });

  afterEach(() => {
    if (originalMeridianData === undefined) {
      delete process.env.MERIDIAN_DATA;
    } else {
      process.env.MERIDIAN_DATA = originalMeridianData;
    }
    if (originalMeridianDataDir === undefined) {
      delete process.env.MERIDIAN_DATA_DIR;
    } else {
      process.env.MERIDIAN_DATA_DIR = originalMeridianDataDir;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('scan, list, and close work through the CLI', async () => {
    fs.writeFileSync(path.join(dir, 'claude-audit-result-cli.md'), [
      '## H1: CLI tracked finding',
      'Severity: high',
      'Status: open',
      'File: lib/example.js:7',
    ].join('\n'));

    const scan = await runAuditDebt(['audit-debt', 'scan', '--root', dir, '--json']);
    const scanned = JSON.parse(scan.stdout);
    expect(scan.exitCode).toBe(0);
    expect(scanned.findingCount).toBe(1);

    const list = await runAuditDebt(['audit-debt', 'list', '--status', 'open', '--json']);
    const listed = JSON.parse(list.stdout);
    expect(listed.findings).toHaveLength(1);
    expect(listed.findings[0]).toMatchObject({
      id: 'claude-audit-result-cli-h1',
      severity: 'high',
      status: 'open',
    });

    const close = await runAuditDebt([
      'audit-debt',
      'close',
      'claude-audit-result-cli-h1',
      '--commit',
      'cafebabe',
      '--json',
    ]);
    const closed = JSON.parse(close.stdout);
    expect(closed.finding).toMatchObject({
      status: 'closed',
      closedInCommit: 'cafebabe',
    });
  });

  test('close rejects missing commit through the CLI', async () => {
    fs.writeFileSync(path.join(dir, 'claude-audit-result-cli-missing-commit.md'), [
      '## H1: CLI tracked finding',
      'Severity: high',
    ].join('\n'));

    await runAuditDebt(['audit-debt', 'scan', '--root', dir, '--json']);

    await expect(runAuditDebt([
      'audit-debt',
      'close',
      'claude-audit-result-cli-missing-commit-h1',
    ])).rejects.toThrow(/required option/i);
  });
});
