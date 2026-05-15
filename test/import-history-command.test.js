'use strict';

// open-source-readiness: allow-private-path-fixtures

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const bin = path.join(__dirname, '..', 'bin', 'meridian.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'import-history-command-'));
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      MERIDIAN_DATA: options.dataDir || tempDir(),
    },
  });
}

describe('import-history project-plan command', () => {
  let dir;

  beforeEach(() => {
    dir = tempDir();
    fs.writeFileSync(path.join(dir, 'README.md'), '# Import me\n');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('prints a safe draft-only project import plan', () => {
    const result = run([
      'import-history',
      'project-plan',
      dir,
      '--project',
      'recall-imports',
      '--now',
      '2026-05-05T00:00:00.000Z',
      '--json',
    ], { dataDir: dir });

    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan).toMatchObject({
      ok: true,
      safety: {
        importTrustState: 'draft',
        initialPartition: 'candidate_basin',
        automaticPromotionAllowed: false,
      },
    });
    expect(plan.commands[0].command).not.toContain('--promote');
  });

  test('exits nonzero for active OneDrive import paths', () => {
    const result = run([
      'import-history',
      'project-plan',
      'C:\\Users\\jesse\\OneDrive\\project',
      '--json',
    ], { dataDir: dir });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      status: 'blocked',
      findings: expect.arrayContaining([
        expect.objectContaining({ id: 'project-path-needs-localization' }),
      ]),
    });
  });
});
