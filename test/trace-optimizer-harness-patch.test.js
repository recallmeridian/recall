'use strict';

const {
  VALID_PATCH_KINDS,
  VALID_IMPACTS,
  buildSystemPrompt,
  buildUserPrompt,
  tryParseJson,
  normalizePatch,
  recommendPatch,
} = require('../lib/trace-optimizer/harness-patch');

describe('harness-patch', () => {
  test('VALID_PATCH_KINDS covers prompt/doc/code/config/guard/test/other', () => {
    expect(VALID_PATCH_KINDS.has('prompt_edit')).toBe(true);
    expect(VALID_PATCH_KINDS.has('doc_edit')).toBe(true);
    expect(VALID_PATCH_KINDS.has('code_edit')).toBe(true);
    expect(VALID_PATCH_KINDS.has('config_edit')).toBe(true);
    expect(VALID_PATCH_KINDS.has('guard_add')).toBe(true);
    expect(VALID_PATCH_KINDS.has('test_add')).toBe(true);
    expect(VALID_PATCH_KINDS.has('other')).toBe(true);
  });

  test('VALID_IMPACTS is high/medium/low', () => {
    expect([...VALID_IMPACTS]).toEqual(['high', 'medium', 'low']);
  });

  test('buildSystemPrompt biases toward harness over model and requires JSON', () => {
    const sys = buildSystemPrompt();
    expect(sys).toMatch(/JSON/);
    expect(sys).toMatch(/harness/i);
    expect(sys).toMatch(/cheapest fix/i);
    expect(sys).toMatch(/before\s*\/\s*after|before\/after/i);
  });

  test('buildUserPrompt embeds basin and reflection JSON', () => {
    const basin = { id: 'b1', pattern: 'sandbox eperm', count: 3, agents: ['impl'], taskTypes: ['implementation'], projects: ['recall-dev'], sampleHandoffIds: ['h1'], rawSamples: ['Sandbox EPERM'] };
    const reflection = { rootCause: 'sandbox blocks spawn', contributingFactors: ['EPERM'], recommendedNextActions: ['lift sandbox'], confidence: 0.9 };
    const prompt = buildUserPrompt(basin, reflection);
    expect(prompt).toMatch(/sandbox eperm/);
    expect(prompt).toMatch(/sandbox blocks spawn/);
    expect(prompt).toMatch(/lift sandbox/);
  });

  test('buildUserPrompt handles null reflection gracefully', () => {
    const basin = { id: 'b1', pattern: 'p', count: 3, agents: [], taskTypes: [], projects: [], sampleHandoffIds: [], rawSamples: [] };
    const prompt = buildUserPrompt(basin, null);
    expect(prompt).toMatch(/null/);
  });

  test('tryParseJson handles raw, fenced json, and embedded blocks', () => {
    expect(tryParseJson('{"patchKind":"prompt_edit"}')).toEqual({ patchKind: 'prompt_edit' });
    expect(tryParseJson('```json\n{"patchKind":"doc_edit"}\n```')).toEqual({ patchKind: 'doc_edit' });
    expect(tryParseJson('preamble {"patchKind":"other"} trailing')).toEqual({ patchKind: 'other' });
    expect(tryParseJson('no json')).toBeNull();
    expect(tryParseJson(null)).toBeNull();
  });

  test('normalizePatch clamps confidence, defaults invalid patchKind to other', () => {
    const out = normalizePatch({
      patchKind: 'invalid-kind',
      target: { file: ' AGENTS.md ', section: ' End-of-Session ', locator: null },
      change: { before: ' old ', after: ' new ', diffSummary: ' summary ' },
      rationale: ' because ',
      estimatedImpact: 'EXTREME',
      riskNotes: ['r1', null, 'r2'],
      confidence: 2.5,
    }, 'mock-model');
    expect(out.patchKind).toBe('other');
    expect(out.target.file).toBe('AGENTS.md');
    expect(out.target.section).toBe('End-of-Session');
    expect(out.change.before).toBe('old');
    expect(out.change.after).toBe('new');
    expect(out.change.diffSummary).toBe('summary');
    expect(out.rationale).toBe('because');
    expect(out.estimatedImpact).toBe('low');
    expect(out.riskNotes).toEqual(['r1', 'r2']);
    expect(out.confidence).toBe(1);
    expect(out.model).toBe('mock-model');
    expect(out.parseFailed).toBe(false);
  });

  test('normalizePatch preserves valid patchKind + impact', () => {
    const out = normalizePatch({
      patchKind: 'prompt_edit',
      estimatedImpact: 'high',
      confidence: 0.8,
    }, 'm');
    expect(out.patchKind).toBe('prompt_edit');
    expect(out.estimatedImpact).toBe('high');
    expect(out.confidence).toBe(0.8);
  });

  test('normalizePatch marks parseFailed when input is null', () => {
    const out = normalizePatch(null, 'm');
    expect(out.parseFailed).toBe(true);
    expect(out.patchKind).toBe('other');
    expect(out.confidence).toBe(0);
  });

  test('recommendPatch sends correct messages and returns normalized patch', async () => {
    let captured;
    const mockLlm = {
      describe() { return { provider: 'mock', baseUrl: 'mock', defaultModel: 'm' }; },
      async chat(req) {
        captured = req;
        return {
          content: JSON.stringify({
            patchKind: 'doc_edit',
            target: { file: 'AGENTS.md', section: 'End-of-Session', locator: null },
            change: {
              before: '(no rule)',
              after: 'When closing a significant session, populate draftLessons + reviewFindings.',
              diffSummary: 'Add end-of-session promotion-readiness rule',
            },
            rationale: 'Significant handoffs without promotion fields produce raw_handoffs that never get promoted to KB.',
            estimatedImpact: 'high',
            riskNotes: ['agents may resist the friction'],
            confidence: 0.85,
          }),
          model: 'mock-model',
          finishReason: 'stop',
        };
      },
    };
    const basin = { id: 'b1', pattern: 'raw_handoff', count: 5, agents: ['impl'], taskTypes: ['implementation'], projects: ['recall-dev'], sampleHandoffIds: ['h1'], rawSamples: [] };
    const reflection = { rootCause: 'no enforcement', contributingFactors: ['only docs'], recommendedNextActions: [], confidence: 0.7 };
    const result = await recommendPatch(basin, reflection, mockLlm);
    expect(result.patchKind).toBe('doc_edit');
    expect(result.target.file).toBe('AGENTS.md');
    expect(result.estimatedImpact).toBe('high');
    expect(result.confidence).toBe(0.85);
    expect(result.parseFailed).toBe(false);
    expect(captured.json).toBe(true);
    expect(captured.messages[0].role).toBe('system');
    expect(captured.messages[1].role).toBe('user');
  });

  test('recommendPatch rejects bad provider', async () => {
    await expect(recommendPatch({ pattern: 'x' }, null, null)).rejects.toThrow(/llmProvider/);
    await expect(recommendPatch({ pattern: 'x' }, null, {})).rejects.toThrow(/chat/);
  });

  test('recommendPatch handles non-JSON response gracefully', async () => {
    const mockLlm = {
      describe() { return { provider: 'mock', baseUrl: 'mock', defaultModel: 'm' }; },
      async chat() {
        return { content: 'the model just rambled', model: 'mock-model', finishReason: 'stop' };
      },
    };
    const result = await recommendPatch({ pattern: 'x', sampleHandoffIds: [], rawSamples: [], agents: [], taskTypes: [], projects: [] }, null, mockLlm);
    expect(result.parseFailed).toBe(true);
    expect(result.patchKind).toBe('other');
  });
});
