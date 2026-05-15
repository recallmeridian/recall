'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const pv = require('../lib/pattern-vault');

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pattern-vault-test-'));
}

function writeEntry(vaultDir, category, id, body) {
  const dir = path.join(vaultDir, category);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(body, null, 2));
}

function writeRelationships(vaultDir, lines) {
  fs.writeFileSync(path.join(vaultDir, 'relationships.jsonl'), lines.map((l) => typeof l === 'string' ? l : JSON.stringify(l)).join('\n'));
}

describe('pattern-vault.readVault', () => {
  test('reads entries from category directories and skips reserved dirs', () => {
    const v = tmpVault();
    writeEntry(v, 'decisions', 'use-typescript', { id: 'use-typescript', name: 'Use TS', description: 'Type safety wins.' });
    writeEntry(v, 'lessons', 'pin-deps', { id: 'pin-deps', name: 'Pin deps', description: 'No surprises.' });
    fs.mkdirSync(path.join(v, 'sources'), { recursive: true });
    fs.writeFileSync(path.join(v, 'sources', 'note.json'), '{}'); // should be skipped
    fs.mkdirSync(path.join(v, 'node_modules', 'foo'), { recursive: true });
    fs.writeFileSync(path.join(v, 'node_modules', 'foo', 'package.json'), '{}');

    const out = pv.readVault(v);
    expect(out.entries).toHaveLength(2);
    expect(out.categories.map((c) => c.name).sort()).toEqual(['decisions', 'lessons']);
  });

  test('marks parse errors without crashing', () => {
    const v = tmpVault();
    fs.mkdirSync(path.join(v, 'decisions'), { recursive: true });
    fs.writeFileSync(path.join(v, 'decisions', 'broken.json'), '{ this is not json');
    const out = pv.readVault(v);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]._parseError).toBeTruthy();
  });

  test('throws when vault directory does not exist', () => {
    expect(() => pv.readVault('/nonexistent/path/that/does/not/exist')).toThrow(/not found/);
  });

  test('skips _index.json engine sentinels so they do not pollute findings', () => {
    // Engine writes one _index.json per project; treating them as entries
    // makes every multi-project vault report _index as duplicate-id N times
    // and missing name/description, drowning real findings.
    const v = tmpVault();
    writeEntry(v, 'decisions', 'use-ts', { id: 'use-ts', name: 'Use TS', description: 'Type safety wins.' });
    fs.mkdirSync(path.join(v, 'decisions'), { recursive: true });
    fs.writeFileSync(path.join(v, 'decisions', '_index.json'), JSON.stringify({ entries: [] }));
    const out = pv.readVault(v);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].id).toBe('use-ts');
  });
});

describe('pattern-vault.validateEntry', () => {
  test('clean entry produces no findings', () => {
    const f = pv.validateEntry({
      id: 'use-typescript', name: 'Use TS', description: 'Type safety wins for this codebase.',
      _category: 'decisions', _path: '/x',
    });
    expect(f).toEqual([]);
  });

  test('flags missing fields', () => {
    const f = pv.validateEntry({ _category: 'decisions', _path: '/x' });
    const codes = f.map((x) => x.code);
    expect(codes).toContain('missing_id');
    expect(codes).toContain('missing_name');
    expect(codes).toContain('missing_description');
  });

  test('flags bad id format as warn (not error)', () => {
    const f = pv.validateEntry({
      id: 'BAD ID', name: 'x', description: 'long enough description',
      _path: '/x',
    });
    const idFinding = f.find((x) => x.code === 'bad_id_format');
    expect(idFinding).toBeDefined();
    expect(idFinding.level).toBe('warn');
  });

  test('flags out-of-range confidence', () => {
    const f = pv.validateEntry({
      id: 'x-y', name: 'x', description: 'long enough',
      confidence: 1.5, _path: '/x',
    });
    expect(f.some((x) => x.code === 'invalid_confidence')).toBe(true);
  });

  test('flags non-array sources', () => {
    const f = pv.validateEntry({
      id: 'x-y', name: 'x', description: 'long enough',
      sources: 'sources/file.md', _path: '/x',
    });
    expect(f.some((x) => x.code === 'non_array_sources')).toBe(true);
  });

  test('flags invalid status', () => {
    const f = pv.validateEntry({
      id: 'x-y', name: 'x', description: 'long enough',
      status: 'wip', _path: '/x',
    });
    expect(f.some((x) => x.code === 'invalid_status')).toBe(true);
  });

  test('canonical status enum accepts all 5 reconciled values', () => {
    // Reconciled against engine real data + pattern doc — active, retired,
    // superseded, closed, disputed are all valid. Three-way drift caught
    // during the 0.26.0 polish pass (validator had active|retired|draft,
    // pattern doc had active|closed|superseded|disputed, engine data had
    // active|retired|superseded|closed|disabled).
    for (const status of ['active', 'retired', 'superseded', 'closed', 'disputed']) {
      const f = pv.validateEntry({
        id: 'x-y', name: 'x', description: 'long enough description', status, _path: '/x',
      });
      expect(f.some((x) => x.code === 'invalid_status')).toBe(false);
    }
  });
});

describe('pattern-vault.validateRelationships', () => {
  const entries = [
    { id: 'a', name: 'a', description: 'aaa' },
    { id: 'b', name: 'b', description: 'bbb' },
  ];

  test('valid relationship passes', () => {
    const f = pv.validateRelationships([{ from: 'a', to: 'b', type: 'supersedes', _line: 1 }], entries);
    expect(f).toEqual([]);
  });

  test('flags invalid type', () => {
    const f = pv.validateRelationships([{ from: 'a', to: 'b', type: 'related', _line: 1 }], entries);
    expect(f.some((x) => x.code === 'relationship_invalid_type')).toBe(true);
  });

  test('flags dangling endpoints', () => {
    const f = pv.validateRelationships([{ from: 'a', to: 'missing', type: 'supersedes', _line: 1 }], entries);
    expect(f.some((x) => x.code === 'relationship_dangling_to')).toBe(true);
  });

  test('flags self-loops', () => {
    const f = pv.validateRelationships([{ from: 'a', to: 'a', type: 'supersedes', _line: 1 }], entries);
    expect(f.some((x) => x.code === 'relationship_self_loop')).toBe(true);
  });

  test('flags missing from/to', () => {
    const f = pv.validateRelationships([{ type: 'supersedes', _line: 1 }], entries);
    const codes = f.map((x) => x.code);
    expect(codes).toContain('relationship_missing_from');
    expect(codes).toContain('relationship_missing_to');
  });
});

describe('pattern-vault.findDuplicateIds', () => {
  test('detects duplicate ids across categories', () => {
    const f = pv.findDuplicateIds([
      { id: 'x', _path: '/decisions/x.json' },
      { id: 'x', _path: '/lessons/x.json' },
      { id: 'y', _path: '/decisions/y.json' },
    ]);
    expect(f).toHaveLength(1);
    expect(f[0].code).toBe('duplicate_id');
  });
});

describe('pattern-vault.computeHealth', () => {
  test('clean vault scores 100', () => {
    expect(pv.computeHealth([], 10, 5)).toBe(100);
  });

  test('empty vault scores 0', () => {
    expect(pv.computeHealth([], 0, 0)).toBe(0);
  });

  test('score is normalized by vault size', () => {
    // Same number of issues, different vault size → bigger vault scores higher
    const findings = Array(5).fill({ code: 'missing_description', level: 'error' });
    const smallScore = pv.computeHealth(findings, 5, 0);
    const bigScore = pv.computeHealth(findings, 200, 0);
    expect(bigScore).toBeGreaterThan(smallScore);
  });

  test('scores decrease with more issues', () => {
    const f1 = [{ code: 'missing_description', level: 'error' }];
    const f5 = Array(5).fill({ code: 'missing_description', level: 'error' });
    expect(pv.computeHealth(f1, 10, 0)).toBeGreaterThan(pv.computeHealth(f5, 10, 0));
  });
});

describe('pattern-vault.classifyHealth', () => {
  test('tier boundaries', () => {
    expect(pv.classifyHealth(95).tier).toBe('excellent');
    expect(pv.classifyHealth(75).tier).toBe('good');
    expect(pv.classifyHealth(55).tier).toBe('fair');
    expect(pv.classifyHealth(35).tier).toBe('poor');
    expect(pv.classifyHealth(10).tier).toBe('critical');
  });
});

describe('pattern-vault.detectDriftSignals — orphan-ratio gating', () => {
  test('does NOT emit high_orphan_ratio when vault has zero relationships', () => {
    // Without this gate, every engine-format vault scored 100% orphan
    // (because it stores relationships inline, not in relationships.jsonl)
    // — drowning real drift signals with a false alarm.
    const entries = [];
    for (let i = 0; i < 20; i++) entries.push({ id: 'e' + i });
    const findings = pv.detectDriftSignals(entries, [], []);
    expect(findings.some((f) => f.code === 'high_orphan_ratio')).toBe(false);
  });

  test('counts inline relationships[] so engine-format vaults score honestly', () => {
    const entries = [];
    for (let i = 0; i < 20; i++) entries.push({ id: 'e' + i, relationships: [] });
    // Two entries have inline relationships pointing at each other; the
    // remaining 18 are real orphans → high_orphan_ratio should fire.
    entries[0].relationships = [{ to: 'e1', type: 'confirms' }];
    entries[1].relationships = [{ to: 'e0', type: 'confirms' }];
    const findings = pv.detectDriftSignals(entries, [], []);
    expect(findings.some((f) => f.code === 'high_orphan_ratio')).toBe(true);
  });
});

describe('pattern-vault.validateVault end-to-end', () => {
  test('clean vault returns 100 health and no findings', () => {
    const v = tmpVault();
    writeEntry(v, 'decisions', 'use-ts', { id: 'use-ts', name: 'Use TS', description: 'Type safety wins.' });
    writeEntry(v, 'lessons', 'pin-deps', { id: 'pin-deps', name: 'Pin deps', description: 'No surprises.' });
    writeRelationships(v, [{ from: 'pin-deps', to: 'use-ts', type: 'confirms' }]);
    const r = pv.validateVault(v);
    expect(r.healthScore).toBe(100);
    expect(r.errorCount).toBe(0);
    expect(r.cleanEntries).toBe(2);
    expect(r.cleanRelationships).toBe(1);
  });

  test('vault with errors has reduced score and finding details', () => {
    const v = tmpVault();
    writeEntry(v, 'decisions', 'broken', { id: 'broken' }); // no name, no description
    writeEntry(v, 'decisions', 'good', { id: 'good', name: 'Good', description: 'fine' });
    writeRelationships(v, [{ from: 'good', to: 'definitely-missing', type: 'supersedes' }]);
    const r = pv.validateVault(v);
    expect(r.healthScore).toBeLessThan(100);
    expect(r.errorCount).toBeGreaterThan(0);
    expect(r.findings.some((f) => f.code === 'missing_name')).toBe(true);
    expect(r.findings.some((f) => f.code === 'relationship_dangling_to')).toBe(true);
  });
});
