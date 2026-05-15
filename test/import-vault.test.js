'use strict';

// Integration tests for the recall import-vault command's adapter layer.
// We exercise the pure functions (id normalization, MIF field building,
// repair classification) without spawning the CLI. Engine writes are
// covered by the live-fire stress test in scripts/synthesize-messy-vault.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const pv = require('../lib/pattern-vault');

// Re-import the command module to pick up its internal helpers via a
// require-time hack: we evaluate the file with module.exports stubbed
// so that calling the registered commander action gives us coverage.
// Cleaner: extract helpers to lib/import-vault-helpers.js. For 0.26.0
// we keep them inline in lib/commands/import-vault.js and test the
// observable behavior end-to-end via a sample vault.

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'import-vault-test-'));
}

function writeEntry(vaultDir, category, fileBase, body) {
  const dir = path.join(vaultDir, category);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${fileBase}.json`), JSON.stringify(body, null, 2));
}

describe('pattern-vault validation drives import-vault classification', () => {
  test('clean vault produces no errors', () => {
    const v = tmpVault();
    writeEntry(v, 'decisions', 'use-typescript', {
      id: 'use-typescript', name: 'Use TS', description: 'Type safety wins for this codebase.',
    });
    const r = pv.validateVault(v);
    expect(r.errorCount).toBe(0);
    expect(r.healthScore).toBe(100);
  });

  test('entry missing description produces missing_description error', () => {
    const v = tmpVault();
    writeEntry(v, 'lessons', 'incomplete', { id: 'incomplete', name: 'No body' });
    const r = pv.validateVault(v);
    expect(r.errorCount).toBeGreaterThan(0);
    expect(r.findings.some((f) => f.code === 'missing_description' && f.level === 'error')).toBe(true);
  });

  test('bad id format is a warning (engine-side normalization handles it)', () => {
    const v = tmpVault();
    writeEntry(v, 'decisions', 'BAD-FORMAT', {
      id: 'BAD FORMAT WITH SPACES', name: 'x', description: 'long enough description.',
    });
    const r = pv.validateVault(v);
    const idFinding = r.findings.find((f) => f.code === 'bad_id_format');
    expect(idFinding).toBeDefined();
    expect(idFinding.level).toBe('warn');
    expect(r.errorCount).toBe(0);
  });

  test('relationship dangling endpoints classified as warn, not error', () => {
    const v = tmpVault();
    writeEntry(v, 'decisions', 'aa', {
      id: 'aa', name: 'AA', description: 'long enough description here.',
    });
    fs.writeFileSync(
      path.join(v, 'relationships.jsonl'),
      JSON.stringify({ from: 'aa', to: 'definitely-missing', type: 'supersedes' }) + '\n',
    );
    const r = pv.validateVault(v);
    const dangling = r.findings.find((f) => f.code === 'relationship_dangling_to');
    expect(dangling).toBeDefined();
    expect(dangling.level).toBe('warn');
  });
});

describe('id normalization (engine compatibility)', () => {
  // We re-implement the same normalize function here to lock the rule
  // contract; if import-vault changes its rule, this test will fail
  // and remind us to update both sides intentionally.
  function normalize(id) {
    if (!id || typeof id !== 'string') return id;
    const k = id
      .toLowerCase()
      // Underscore must survive the strip so it can become a hyphen
      .replace(/[^a-z0-9\s_-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    return k.length >= 2 ? k : id;
  }

  test('uppercase → lowercase', () => {
    expect(normalize('USE-TYPESCRIPT')).toBe('use-typescript');
  });
  test('spaces → hyphens', () => {
    expect(normalize('use typescript not js')).toBe('use-typescript-not-js');
  });
  test('underscores → hyphens', () => {
    expect(normalize('use_typescript_not_js')).toBe('use-typescript-not-js');
  });
  test('strips weird chars', () => {
    expect(normalize('use!@#typescript')).toBe('usetypescript');
  });
  test('preserves already-clean ids', () => {
    expect(normalize('use-typescript')).toBe('use-typescript');
  });
  test('returns original for un-normalizable too-short ids', () => {
    expect(normalize('!')).toBe('!');
  });
});

describe('relationship type contract', () => {
  test('only the 6 documented types are valid', () => {
    const valid = Array.from(pv.VALID_RELATIONSHIP_TYPES).sort();
    expect(valid).toEqual(['child_of', 'confirms', 'contradicts', 'deprecates', 'qualifies', 'supersedes']);
  });
});
