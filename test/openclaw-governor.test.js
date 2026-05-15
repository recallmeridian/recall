'use strict';

const { validateManifest } = require('../lib/specialist-runner');
const mod = require('../lib/specialists/openclaw-governor');

describe('openclaw-governor specialist bundle', () => {
  test('loads with correct id and semver version', () => {
    expect(mod.id).toBe('openclaw-governor');
    expect(mod.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('passes the specialist-runner manifest validator', () => {
    expect(() => validateManifest(mod.specialist)).not.toThrow();
  });

  test('declares ILLMProvider as required port', () => {
    expect(mod.specialist.requiredPorts).toContain('ILLMProvider');
  });

  test('system prompt encodes default-deny and egress-review rules', () => {
    const sys = mod.specialist.promptTemplates.system;
    expect(sys).toMatch(/default-deny/i);
    expect(sys).toMatch(/egress/i);
    expect(sys).toMatch(/review/);
    expect(sys).toMatch(/JSON/);
    expect(sys).toMatch(/Recall Meridian/);
  });

  test('output schema requires the load-bearing fields', () => {
    const required = mod.specialist.outputSchema.required;
    expect(required).toContain('decision');
    expect(required).toContain('confidence');
    expect(required).toContain('blockers');
    expect(required).toContain('scopeBoundary');
  });

  test('user-message builder embeds proposed action and retrieved context', () => {
    const msg = mod.specialist.promptTemplates.user({
      input: { actionKind: 'post', target: { channel: 'moltbook', text: 'hello' }, rationale: 'test' },
      retrievedContext: [
        { category: 'decisions', project: 'recall-dev', id: 'd-1', name: 'brand rule', description: 'use Recall Meridian in user-facing copy' },
      ],
    });
    expect(msg).toContain('moltbook');
    expect(msg).toContain('hello');
    expect(msg).toContain('d-1');
    expect(msg).toContain('Recall Meridian');
  });

  test('user-message builder warns when retrievedContext is empty', () => {
    const msg = mod.specialist.promptTemplates.user({
      input: 'do thing',
      retrievedContext: [],
    });
    expect(msg).toMatch(/lacks grounding context/i);
    expect(msg).toMatch(/review.*block/i);
  });

  test('user-message builder serializes structured input to JSON', () => {
    const msg = mod.specialist.promptTemplates.user({
      input: { actionKind: 'post', target: { text: 'hi' } },
      retrievedContext: [],
    });
    expect(msg).toContain('"actionKind"');
    expect(msg).toContain('"post"');
  });

  test('has at least six evaluation cases covering the doctrine surfaces', () => {
    const cases = mod.specialist.evaluationCases;
    expect(cases.length).toBeGreaterThanOrEqual(6);
    for (const c of cases) {
      expect(c.id).toBeTruthy();
      expect(c.input).toBeTruthy();
      expect(c.expected).toBeTruthy();
    }
  });

  test('eval cases cover private-leak, brand, egress, missing-evidence', () => {
    const cases = mod.specialist.evaluationCases;
    const ids = cases.map((c) => c.id);
    expect(ids.some((id) => id.includes('private-path'))).toBe(true);
    expect(ids.some((id) => id.includes('brand'))).toBe(true);
    expect(ids.some((id) => id.includes('egress'))).toBe(true);
    expect(ids.some((id) => id.includes('missing-evidence'))).toBe(true);
    expect(ids.some((id) => id.includes('raw-memory') || id.includes('memory-leak'))).toBe(true);
  });

  test('all blocking eval cases produce "block" or "review" as expected decisions', () => {
    const blockingIds = ['eval-1-private-path-leak', 'eval-2-bare-brand', 'eval-6-raw-memory-leak'];
    for (const c of mod.specialist.evaluationCases.filter((x) => blockingIds.includes(x.id))) {
      expect(c.expected.decisionInSet).toEqual(expect.arrayContaining(expect.any(Array).length > 0 ? c.expected.decisionInSet : ['block']));
      expect(
        c.expected.decisionInSet.includes('block') || c.expected.decisionInSet.includes('review')
      ).toBe(true);
    }
  });

  test('retrieval recipe pulls from decisions, lessons, features', () => {
    const queries = mod.specialist.retrievalRecipe.queries.map((q) => q.category);
    expect(queries).toContain('decisions');
    expect(queries).toContain('lessons');
    expect(queries).toContain('features');
  });
});
