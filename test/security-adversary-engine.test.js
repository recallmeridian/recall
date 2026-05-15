'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { generateAttacks, runAdversaryRun, ATTACK_CATEGORIES } = require('../lib/security/adversary-engine');
const { scanContent } = require('../lib/security/egress-scanner');
const { rulesEvaluator } = require('../lib/security/evaluator-ensemble');

describe('adversary engine: attack generation', () => {
  test('generates the requested count of attacks', () => {
    const a = generateAttacks({ count: 12, seed: 1 });
    expect(a).toHaveLength(12);
    for (const x of a) {
      expect(x.id).toMatch(/^adv-/);
      expect(x.content.length).toBeGreaterThan(10);
      expect(['allow', 'block', 'review']).toContain(x.expectedDecision);
    }
  });

  test('seeded generation is deterministic', () => {
    const a = generateAttacks({ count: 8, seed: 99 });
    const b = generateAttacks({ count: 8, seed: 99 });
    expect(a.map((x) => x.content)).toEqual(b.map((x) => x.content));
  });

  test('different seeds produce different content', () => {
    const a = generateAttacks({ count: 8, seed: 1 });
    const b = generateAttacks({ count: 8, seed: 2 });
    const aContents = a.map((x) => x.content).join('|');
    const bContents = b.map((x) => x.content).join('|');
    expect(aContents).not.toBe(bContents);
  });

  test('category filter restricts to those categories', () => {
    const a = generateAttacks({ count: 30, seed: 1, categories: ['api-key-leak'] });
    for (const x of a) expect(x.category).toBe('api-key-leak');
  });

  test('every catalog category is represented somewhere in 50 samples', () => {
    const a = generateAttacks({ count: 200, seed: 7 });
    const seen = new Set(a.map((x) => x.category));
    for (const cat of Object.keys(ATTACK_CATEGORIES)) {
      expect(seen.has(cat)).toBe(true);
    }
  });
});

describe('adversary engine: run loop', () => {
  test('run with one defense produces per-attack results + summary', () => {
    const attacks = generateAttacks({ count: 6, seed: 1 });
    const defenses = [{
      name: 'always-allow',
      kind: 'stub',
      evaluate: () => ({ decision: 'allow' }),
    }];
    const r = runAdversaryRun({ attacks, defenses });
    expect(r.results).toHaveLength(6);
    expect(r.summary.total).toBe(6);
    // Always-allow only matches the clean-control category
    const cleanResults = r.results.filter((x) => x.category === 'clean-control');
    if (cleanResults.length) {
      expect(cleanResults.every((x) => x.anyMatched)).toBe(true);
    }
  });

  test('egress-scanner defense catches the attack categories it covers', () => {
    const attacks = generateAttacks({ count: 30, seed: 7 });
    const defenses = [{
      name: 'egress-scanner',
      kind: 'rules',
      evaluate: (content) => scanContent({ content, kind: 'inline' }),
    }];
    const r = runAdversaryRun({ attacks, defenses });
    expect(r.summary.catchRateAny).toBeGreaterThan(0.5);
  });

  test('multiple defenses: catch rate uses any-matched', () => {
    const attacks = [
      { id: 'a1', category: 'api-key-leak', content: 'sk-ant-' + 'a'.repeat(95), expectedDecision: 'block', expectedReasons: [] },
    ];
    const defenses = [
      { name: 'always-allow', kind: 'stub', evaluate: () => ({ decision: 'allow' }) },
      { name: 'egress-scanner', kind: 'rules', evaluate: (c) => scanContent({ content: c }) },
    ];
    const r = runAdversaryRun({ attacks, defenses });
    expect(r.results[0].anyMatched).toBe(true); // scanner catches it
    expect(r.results[0].allMatched).toBe(false); // always-allow doesn't
    expect(r.summary.catchRateAny).toBe(1);
    expect(r.summary.catchRateAll).toBe(0);
  });

  test('defense errors do not crash the run', () => {
    const attacks = generateAttacks({ count: 3, seed: 1 });
    const defenses = [
      { name: 'crashy', kind: 'stub', evaluate: () => { throw new Error('boom'); } },
    ];
    const r = runAdversaryRun({ attacks, defenses });
    expect(r.results).toHaveLength(3);
    for (const x of r.results) {
      expect(x.defenses[0].decision).toBe('review'); // safeEvaluate fallback
    }
  });

  test('appends to adversary-run-ledger when dataDir provided', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advrun-test-'));
    try {
      const attacks = generateAttacks({ count: 3, seed: 1 });
      const defenses = [{ name: 'allow', kind: 'stub', evaluate: () => ({ decision: 'allow' }) }];
      const r = runAdversaryRun({ attacks, defenses, opts: { dataDir } });
      expect(r.ledgerEntry).toBeTruthy();
      expect(r.ledgerEntry.sequence).toBe(1);
      const second = runAdversaryRun({ attacks, defenses, opts: { dataDir } });
      expect(second.ledgerEntry.sequence).toBe(2);
      expect(second.ledgerEntry.previousHash).toBe(r.ledgerEntry.entryHash);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('rules evaluator catches api-key + credential-env attacks', () => {
    const attacks = generateAttacks({ count: 40, seed: 12, categories: ['api-key-leak', 'credential-env-line'] });
    const defenses = [{
      name: 'recall-rules',
      kind: 'rules',
      evaluate: (content) => {
        const scan = scanContent({ content });
        return rulesEvaluator().evaluate({ blockers: scan.blockers, warnings: scan.warnings, content });
      },
    }];
    const r = runAdversaryRun({ attacks, defenses });
    expect(r.summary.catchRateAny).toBeGreaterThan(0.7);
  });
});
