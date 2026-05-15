'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  STATUS_APPLIED,
  STATUS_UNSUPPORTED,
  STATUS_TARGET_MISSING,
  STATUS_BEFORE_NOT_FOUND,
  STATUS_AFTER_NO_CHANGE,
  verifyPatch,
} = require('../lib/trace-optimizer/verification-runner');

function makeFixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trace-verify-test-'));
}

function writeFixture(dir, relPath, content) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

describe('verification-runner', () => {
  let repoRoot;

  beforeEach(() => {
    repoRoot = makeFixtureDir();
  });

  afterEach(() => {
    try { fs.rmSync(repoRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });

  test('unsupported patchKind returns status=unsupported and never reads files', () => {
    const result = verifyPatch({
      patchKind: 'guard_add',
      target: { file: 'lib/x.js' },
      change: { before: 'a', after: 'b' },
    }, { repoRoot });
    expect(result.status).toBe(STATUS_UNSUPPORTED);
    expect(result.applied).toBe(false);
    expect(result.syntaxValid).toBeNull();
  });

  test('missing target file returns status=target_missing', () => {
    const result = verifyPatch({
      patchKind: 'doc_edit',
      target: { file: 'does-not-exist.md' },
      change: { before: 'x', after: 'y' },
    }, { repoRoot });
    expect(result.status).toBe(STATUS_TARGET_MISSING);
    expect(result.applied).toBe(false);
  });

  test('doc_edit with matching before string applies cleanly to temp copy', () => {
    writeFixture(repoRoot, 'AGENTS.md', '# Heading\n\nold text\n\nMore.\n');
    const result = verifyPatch({
      patchKind: 'doc_edit',
      target: { file: 'AGENTS.md' },
      change: { before: 'old text', after: 'new text' },
    }, { repoRoot });
    expect(result.status).toBe(STATUS_APPLIED);
    expect(result.applied).toBe(true);
    expect(result.syntaxValid).toBeNull();
    expect(fs.existsSync(result.tempCopy)).toBe(true);
    expect(fs.readFileSync(result.tempCopy, 'utf8')).toContain('new text');
    expect(fs.readFileSync(result.tempCopy, 'utf8')).not.toContain('old text');
    expect(fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8')).toContain('old text');
    fs.rmSync(result.tempCopy, { force: true });
  });

  test('doc_edit where before string is absent returns before_not_found', () => {
    writeFixture(repoRoot, 'AGENTS.md', 'totally unrelated content');
    const result = verifyPatch({
      patchKind: 'doc_edit',
      target: { file: 'AGENTS.md' },
      change: { before: 'something else', after: 'replacement' },
    }, { repoRoot });
    expect(result.status).toBe(STATUS_BEFORE_NOT_FOUND);
    expect(result.applied).toBe(false);
  });

  test('additive patch (empty before, non-empty after) appends after to end', () => {
    writeFixture(repoRoot, 'AGENTS.md', 'existing line\n');
    const result = verifyPatch({
      patchKind: 'prompt_edit',
      target: { file: 'AGENTS.md' },
      change: { before: '', after: '## New section\n\nNew content.' },
    }, { repoRoot });
    expect(result.status).toBe(STATUS_APPLIED);
    expect(result.applied).toBe(true);
    const patched = fs.readFileSync(result.tempCopy, 'utf8');
    expect(patched).toContain('existing line');
    expect(patched).toContain('## New section');
    expect(patched.endsWith('\n')).toBe(true);
    fs.rmSync(result.tempCopy, { force: true });
  });

  test('empty before AND empty after returns after_no_change', () => {
    writeFixture(repoRoot, 'AGENTS.md', 'content');
    const result = verifyPatch({
      patchKind: 'doc_edit',
      target: { file: 'AGENTS.md' },
      change: { before: '', after: '' },
    }, { repoRoot });
    expect(result.status).toBe(STATUS_AFTER_NO_CHANGE);
    expect(result.applied).toBe(false);
  });

  test('before === after returns after_no_change', () => {
    writeFixture(repoRoot, 'README.md', 'same content');
    const result = verifyPatch({
      patchKind: 'doc_edit',
      target: { file: 'README.md' },
      change: { before: 'same content', after: 'same content' },
    }, { repoRoot });
    expect(result.status).toBe(STATUS_AFTER_NO_CHANGE);
    expect(result.applied).toBe(false);
  });

  test('code_edit on JS file with valid result sets syntaxValid=true', () => {
    writeFixture(repoRoot, 'lib/x.js', 'function a() { return 1; }\nmodule.exports = a;\n');
    const result = verifyPatch({
      patchKind: 'code_edit',
      target: { file: 'lib/x.js' },
      change: {
        before: 'return 1;',
        after: 'return 2;',
      },
    }, { repoRoot });
    expect(result.status).toBe(STATUS_APPLIED);
    expect(result.syntaxValid).toBe(true);
    fs.rmSync(result.tempCopy, { force: true });
  });

  test('code_edit on JS file with broken result sets syntaxValid=false and notes', () => {
    writeFixture(repoRoot, 'lib/x.js', 'function a() { return 1; }\nmodule.exports = a;\n');
    const result = verifyPatch({
      patchKind: 'code_edit',
      target: { file: 'lib/x.js' },
      change: {
        before: 'return 1;',
        after: 'return @@@;', // syntax error
      },
    }, { repoRoot });
    expect(result.status).toBe(STATUS_APPLIED);
    expect(result.syntaxValid).toBe(false);
    expect(result.notes.some((n) => /node --check failed/.test(n))).toBe(true);
    fs.rmSync(result.tempCopy, { force: true });
  });

  test('code_edit on non-JS file skips syntax check with a note', () => {
    writeFixture(repoRoot, 'config.txt', 'old=true\n');
    const result = verifyPatch({
      patchKind: 'code_edit',
      target: { file: 'config.txt' },
      change: { before: 'old=true', after: 'old=false' },
    }, { repoRoot });
    expect(result.status).toBe(STATUS_APPLIED);
    expect(result.syntaxValid).toBeNull();
    expect(result.notes.some((n) => /syntax check skipped/.test(n))).toBe(true);
    fs.rmSync(result.tempCopy, { force: true });
  });

  test('basinId and patchKind are carried through onto the result', () => {
    writeFixture(repoRoot, 'A.md', 'hello');
    const result = verifyPatch({
      patchKind: 'doc_edit',
      target: { file: 'A.md' },
      change: { before: 'hello', after: 'world' },
    }, { repoRoot, basinId: 'basin-test-123' });
    expect(result.basinId).toBe('basin-test-123');
    expect(result.patchKind).toBe('doc_edit');
    fs.rmSync(result.tempCopy, { force: true });
  });

  test('verifyPatch never modifies the original file', () => {
    const original = '# Heading\n\nold text\n';
    writeFixture(repoRoot, 'AGENTS.md', original);
    verifyPatch({
      patchKind: 'doc_edit',
      target: { file: 'AGENTS.md' },
      change: { before: 'old text', after: 'NEW' },
    }, { repoRoot });
    expect(fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8')).toBe(original);
  });
});
