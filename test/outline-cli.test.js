'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CLI = path.join(__dirname, '..', 'bin', 'meridian.js');
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'strategic-outline', 'recall-fixture');

function copyFixture(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(FIXTURE_ROOT, { withFileTypes: true })) {
    if (entry.isFile()) {
      fs.copyFileSync(path.join(FIXTURE_ROOT, entry.name), path.join(dest, entry.name));
    }
  }
}

describe('recall outline CLI', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'outline-cli-'));
    copyFixture(tmpRoot);
  });

  test('--print writes markdown to stdout, does not write outline files to disk', () => {
    const stdout = execFileSync('node', [CLI, 'outline', '--print', '--root', tmpRoot], { encoding: 'utf8' });
    expect(stdout).toContain('Strategic Outline');
    expect(stdout).toContain('fixture-trading');
    expect(stdout).toContain('Unified intelligence substrate');
    expect(fs.existsSync(path.join(tmpRoot, 'strategic-outline.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, 'strategic-outline.html'))).toBe(false);
  });

  test('--write writes both markdown and html files to disk', () => {
    execFileSync('node', [CLI, 'outline', '--write', '--root', tmpRoot]);
    expect(fs.existsSync(path.join(tmpRoot, 'strategic-outline.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'strategic-outline.html'))).toBe(true);
    const md = fs.readFileSync(path.join(tmpRoot, 'strategic-outline.md'), 'utf8');
    expect(md).toContain('fixture-trading');
  });

  test('default (no flag) behaves as --write', () => {
    execFileSync('node', [CLI, 'outline', '--root', tmpRoot]);
    expect(fs.existsSync(path.join(tmpRoot, 'strategic-outline.md'))).toBe(true);
  });
});
