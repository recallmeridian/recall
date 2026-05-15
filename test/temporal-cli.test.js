'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const meridian = require('../lib/meridian-core');

const bin = path.join(__dirname, '..', 'bin', 'meridian.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recall-temporal-cli-'));
}

function seed(dataDir) {
  const kb = meridian.init(dataDir);
  kb.createProject({ id: 'research', name: 'Research', description: 'Temporal CLI test project' });
  kb.addEntry('research', {
    name: 'Kelly fraction 0.50',
    description: 'Sensitive-domain bot used Kelly fraction 0.50 before the calibration audit.',
    category: 'parameter',
    status: 'active',
    _extensions: {
      temporal: {
        valid_from: '2026-03-01T00:00:00.000Z',
        valid_to: '2026-04-02T00:00:00.000Z',
        superseded_by: ['kelly-fraction-025'],
      },
    },
    confidence: {
      value: 0.7,
      lastVerified: '2026-04-02T00:00:00.000Z',
      decayDays: 30,
      exempt: false,
      verificationStatus: 'verified',
    },
    fusion: { fusedFrom: [], fusedAt: null, fusionDepth: 0 },
  });
  kb.addEntry('research', {
    name: 'Kelly fraction 0.25',
    description: 'Sensitive-domain bot used Kelly fraction 0.25 after the calibration audit.',
    category: 'parameter',
    status: 'active',
    _extensions: {
      temporal: {
        valid_from: '2026-04-02T00:00:00.000Z',
        supersedes: ['kelly-fraction-050'],
      },
    },
    confidence: {
      value: 0.7,
      lastVerified: '2026-04-02T00:00:00.000Z',
      decayDays: 30,
      exempt: false,
      verificationStatus: 'verified',
    },
    fusion: { fusedFrom: [], fusedAt: null, fusionDepth: 0 },
  });
  kb.close();
}

function run(dataDir, args) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      MERIDIAN_DATA: dataDir,
    },
  });
}

describe('temporal CLI surfaces', () => {
  let dir;

  beforeEach(() => {
    dir = tempDir();
    seed(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('search --as-of filters entries by valid-time window', () => {
    const march = run(dir, ['search', 'research', 'Kelly fraction', '--as-of', '2026-03-20T00:00:00.000Z']);
    const april = run(dir, ['search', 'research', 'Kelly fraction', '--as-of', '2026-04-02T00:00:00.000Z']);

    expect(march.status).toBe(0);
    expect(march.stdout).toContain('kelly-fraction-050');
    expect(march.stdout).not.toContain('kelly-fraction-025');
    expect(march.stdout).toContain('2026-03-01..2026-04-02');

    expect(april.status).toBe(0);
    expect(april.stdout).toContain('kelly-fraction-025');
    expect(april.stdout).not.toContain('kelly-fraction-050');
    expect(april.stdout).toContain('2026-04-02..now');
  });

  test('browse --as-of reports excluded temporal windows', () => {
    const result = run(dir, ['browse', 'research', '--as-of', '2026-04-10T00:00:00.000Z']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 shown, 1 outside window, 0 unknown');
    expect(result.stdout).toContain('kelly-fraction-025');
    expect(result.stdout).not.toContain('kelly-fraction-050');
  });
});
