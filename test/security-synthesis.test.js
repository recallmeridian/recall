'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  buildSynthesis,
  appendSynthesisLedger,
  listSyntheses,
  verifySynthesisLedger,
  SYNTHESIS_TYPES,
} = require('../lib/security/synthesis');

const sources = [
  { id: 'lesson-a', project: 'recall-dev', name: 'Always cite the decision id', confidence: 0.9 },
  { id: 'lesson-b', project: 'recall-dev', name: 'Per-claim provenance in walkthroughs', confidence: 0.85 },
  { id: 'lesson-c', project: 'recall-dev', name: 'Holdout discipline beats single-set tests', confidence: 0.95 },
];

describe('synthesis service: buildSynthesis', () => {
  test('throws on missing sources', () => {
    expect(() => buildSynthesis({ synthesisType: 'confluence', name: 'n', project: 'p' })).toThrow(/sources/);
  });

  test('throws on unknown synthesisType', () => {
    expect(() => buildSynthesis({ sources, synthesisType: 'made-up', name: 'n', project: 'p' })).toThrow(/synthesisType/);
  });

  test('throws on missing name or project', () => {
    expect(() => buildSynthesis({ sources, synthesisType: 'confluence', project: 'p' })).toThrow(/name/);
    expect(() => buildSynthesis({ sources, synthesisType: 'confluence', name: 'n' })).toThrow(/project/);
  });

  test('throws when source lacks id or project', () => {
    expect(() => buildSynthesis({ sources: [{ id: 'x' }], synthesisType: 'confluence', name: 'n', project: 'p' })).toThrow(/each source needs/);
  });

  test('confluence synthesis emits entry + confirms relationships', () => {
    const r = buildSynthesis({
      sources, synthesisType: 'confluence',
      name: 'Doctrine: cite the decision id in every change',
      project: 'recall-dev',
    });
    expect(r.synthesisEntry.id).toMatch(/^synth-/);
    expect(r.synthesisEntry.category).toBe('lessons');
    expect(r.synthesisEntry.synthesisType).toBe('confluence');
    expect(r.synthesisEntry.synthesisSources).toHaveLength(3);
    expect(r.synthesisEntry.description).toContain('Confluence synthesis');
    expect(r.synthesisEntry.description).toContain('lesson-a');
    expect(r.synthesisEntry.confidence).toBeGreaterThan(0.8);
    expect(r.synthesisEntry.confidence).toBeLessThan(1);
    expect(r.citationRelationships).toHaveLength(3);
    for (const rel of r.citationRelationships) {
      expect(rel.type).toBe('confirms');
      expect(rel.source_id).toBe(r.synthesisEntry.id);
    }
  });

  test('contradiction synthesis emits contradicts relationships', () => {
    const r = buildSynthesis({
      sources: sources.slice(0, 2),
      synthesisType: 'contradiction',
      name: 'Dispute over X',
      project: 'recall-dev',
    });
    expect(r.synthesisEntry.description).toContain('Contradiction synthesis');
    expect(r.synthesisEntry.description).toContain('DISPUTED');
    for (const rel of r.citationRelationships) expect(rel.type).toBe('contradicts');
  });

  test('abstraction synthesis emits confirms (specific → general)', () => {
    const r = buildSynthesis({
      sources, synthesisType: 'abstraction',
      name: 'General rule: cite or be rejected',
      project: 'recall-dev',
      reflection: { merged: { rootCause: 'All three lessons share the citation-discipline pattern' }, agreement: { rootCauseConsensus: 0.9 } },
    });
    expect(r.synthesisEntry.description).toContain('Abstraction synthesis');
    expect(r.synthesisEntry.description).toContain('Abstracted insight');
    for (const rel of r.citationRelationships) expect(rel.type).toBe('confirms');
  });

  test('extraction synthesis emits qualifies relationship', () => {
    const r = buildSynthesis({
      sources: [{ id: 'long-paper', project: 'research', name: 'A long paper', confidence: 0.95 }],
      synthesisType: 'extraction',
      name: 'Extracted: anti-Goodhart axis',
      project: 'research',
    });
    expect(r.synthesisEntry.description).toContain('Extraction synthesis');
    expect(r.citationRelationships[0].type).toBe('qualifies');
  });

  test('retire-recommendation synthesis emits deprecates relationships', () => {
    const r = buildSynthesis({
      sources: [
        { id: 'old-thought-1', project: 'recall-dev', name: 'stale claim', confidence: 0.3 },
        { id: 'old-thought-2', project: 'recall-dev', name: 'also stale', confidence: 0.2 },
      ],
      synthesisType: 'retire-recommendation',
      name: 'Retire: superseded thoughts',
      project: 'recall-dev',
    });
    expect(r.synthesisEntry.description).toContain('Retirement recommendation');
    expect(r.synthesisEntry.description).toContain('require human approval');
    for (const rel of r.citationRelationships) expect(rel.type).toBe('deprecates');
  });

  test('reflection consensus biases synthesis confidence', () => {
    const high = buildSynthesis({
      sources, synthesisType: 'confluence', name: 'n', project: 'p',
      reflection: { merged: { rootCause: 'r' }, agreement: { rootCauseConsensus: 0.95 } },
    });
    const low = buildSynthesis({
      sources, synthesisType: 'confluence', name: 'n', project: 'p',
      reflection: { merged: { rootCause: 'r' }, agreement: { rootCauseConsensus: 0.1 } },
    });
    expect(high.synthesisEntry.confidence).toBeGreaterThan(low.synthesisEntry.confidence);
  });

  test('confidence is clamped to [0.05, 0.99]', () => {
    const r = buildSynthesis({
      sources: [{ id: 'a', project: 'p', confidence: 1.5 }],
      synthesisType: 'confluence', name: 'n', project: 'p',
      consensusBonus: 5,
    });
    expect(r.synthesisEntry.confidence).toBeLessThanOrEqual(0.99);

    const r2 = buildSynthesis({
      sources: [{ id: 'a', project: 'p', confidence: -1 }],
      synthesisType: 'confluence', name: 'n', project: 'p',
      consensusBonus: -5,
    });
    expect(r2.synthesisEntry.confidence).toBeGreaterThanOrEqual(0.05);
  });

  test('synthesisId is deterministic for same sources + type + name', () => {
    const a = buildSynthesis({ sources, synthesisType: 'confluence', name: 'X', project: 'p' });
    const b = buildSynthesis({ sources, synthesisType: 'confluence', name: 'X', project: 'p' });
    expect(a.synthesisEntry.id).toBe(b.synthesisEntry.id);
  });

  test('synthesisId differs when sources differ', () => {
    const a = buildSynthesis({ sources, synthesisType: 'confluence', name: 'X', project: 'p' });
    const b = buildSynthesis({ sources: sources.slice(0, 2), synthesisType: 'confluence', name: 'X', project: 'p' });
    expect(a.synthesisEntry.id).not.toBe(b.synthesisEntry.id);
  });
});

describe('synthesis service: ledger', () => {
  let dataDir;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesis-test-'));
  });
  afterEach(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('appendSynthesisLedger writes hash-chained entry', () => {
    const r1 = buildSynthesis({ sources, synthesisType: 'confluence', name: 'a', project: 'recall-dev' });
    const e1 = appendSynthesisLedger(r1, { dataDir });
    expect(e1.sequence).toBe(1);
    expect(e1.previousHash).toBeNull();

    const r2 = buildSynthesis({ sources, synthesisType: 'abstraction', name: 'b', project: 'recall-dev' });
    const e2 = appendSynthesisLedger(r2, { dataDir });
    expect(e2.sequence).toBe(2);
    expect(e2.previousHash).toBe(e1.entryHash);
  });

  test('listSyntheses filters by project', () => {
    appendSynthesisLedger(buildSynthesis({ sources, synthesisType: 'confluence', name: 'a', project: 'recall-dev' }), { dataDir });
    appendSynthesisLedger(buildSynthesis({ sources: [{ id: 'x', project: 'research' }], synthesisType: 'extraction', name: 'b', project: 'research' }), { dataDir });
    expect(listSyntheses({ dataDir }).length).toBe(2);
    expect(listSyntheses({ dataDir, project: 'recall-dev' }).length).toBe(1);
  });

  test('verifySynthesisLedger detects tampering', () => {
    appendSynthesisLedger(buildSynthesis({ sources, synthesisType: 'confluence', name: 'a', project: 'recall-dev' }), { dataDir });
    appendSynthesisLedger(buildSynthesis({ sources, synthesisType: 'abstraction', name: 'b', project: 'recall-dev' }), { dataDir });
    const ledgerFile = path.join(dataDir, 'security', 'synthesis-ledger.jsonl');
    const lines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[0]);
    tampered.name = 'forged'; // change name → entryHash mismatch
    lines[0] = JSON.stringify(tampered);
    fs.writeFileSync(ledgerFile, lines.join('\n') + '\n');
    const r = verifySynthesisLedger({ dataDir });
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe(1);
  });

  test('verifySynthesisLedger passes on untampered chain', () => {
    for (const t of ['confluence', 'abstraction', 'contradiction']) {
      appendSynthesisLedger(buildSynthesis({ sources, synthesisType: t, name: t, project: 'p' }), { dataDir });
    }
    const r = verifySynthesisLedger({ dataDir });
    expect(r.ok).toBe(true);
    expect(r.entries).toBe(3);
  });
});

describe('synthesis service: exposed constants', () => {
  test('SYNTHESIS_TYPES has all 5 types', () => {
    expect(Object.values(SYNTHESIS_TYPES).sort()).toEqual(['abstraction', 'confluence', 'contradiction', 'extraction', 'retire-recommendation']);
  });
});
