'use strict';

const {
  buildSystemPrompt,
  buildUserPrompt,
  tryParseJson,
  normalizeReflection,
  reflectOnBasin,
} = require('../lib/trace-optimizer/trace-reflection');

describe('trace-reflection', () => {
  test('buildSystemPrompt mentions JSON-only output and harness-over-model preference', () => {
    const sys = buildSystemPrompt();
    expect(sys).toMatch(/JSON/);
    expect(sys).toMatch(/harness/i);
    expect(sys).toMatch(/root cause/i);
  });

  test('buildUserPrompt embeds basin summary + sample handoffs', () => {
    const basin = {
      pattern: 'sandbox eperm',
      count: 3,
      agents: ['impl'],
      taskTypes: ['implementation'],
      projects: ['recall-dev'],
      sampleHandoffIds: ['h1', 'h2'],
      rawSamples: ['Sandbox EPERM'],
    };
    const handoffs = [{ id: 'h1', taskSummary: 'thing' }];
    const prompt = buildUserPrompt(basin, handoffs);
    expect(prompt).toMatch(/sandbox eperm/);
    expect(prompt).toMatch(/h1/);
  });

  test('tryParseJson handles raw object, fenced block, and embedded JSON', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(tryParseJson('```\n{"a":3}\n```')).toEqual({ a: 3 });
    expect(tryParseJson('prefix garbage {"a":4} suffix')).toEqual({ a: 4 });
    expect(tryParseJson('no json here')).toBeNull();
    expect(tryParseJson(null)).toBeNull();
  });

  test('normalizeReflection clamps confidence and stringifies arrays', () => {
    const out = normalizeReflection({
      rootCause: '  cause  ',
      contributingFactors: ['a', null, undefined, 'b'],
      recommendedNextActions: 'not an array',
      confidence: 1.5,
    }, 'test-model');
    expect(out.rootCause).toBe('cause');
    expect(out.contributingFactors).toEqual(['a', 'b']);
    expect(out.recommendedNextActions).toEqual([]);
    expect(out.confidence).toBe(1);
    expect(out.model).toBe('test-model');
    expect(out.parseFailed).toBe(false);
  });

  test('normalizeReflection marks parseFailed when input is null', () => {
    const out = normalizeReflection(null, 'm');
    expect(out.parseFailed).toBe(true);
    expect(out.rootCause).toBe('');
    expect(out.confidence).toBe(0);
  });

  test('reflectOnBasin sends correct messages and returns normalized reflection', async () => {
    let captured;
    const mockLlm = {
      describe() { return { provider: 'mock', baseUrl: 'mock', defaultModel: 'm' }; },
      async chat(req) {
        captured = req;
        return {
          content: JSON.stringify({
            rootCause: 'mock root cause',
            contributingFactors: ['f1', 'f2'],
            recommendedNextActions: ['a1'],
            confidence: 0.8,
          }),
          model: 'mock-model',
          finishReason: 'stop',
        };
      },
    };
    const basin = {
      pattern: 'mock pattern',
      count: 3,
      agents: ['impl'],
      taskTypes: ['implementation'],
      projects: ['recall-dev'],
      sampleHandoffIds: ['h1'],
      rawSamples: ['mock pattern'],
    };
    const result = await reflectOnBasin(basin, [{ id: 'h1' }], mockLlm);
    expect(result.rootCause).toBe('mock root cause');
    expect(result.contributingFactors).toEqual(['f1', 'f2']);
    expect(result.recommendedNextActions).toEqual(['a1']);
    expect(result.confidence).toBe(0.8);
    expect(result.model).toBe('mock-model');
    expect(result.parseFailed).toBe(false);
    expect(captured.json).toBe(true);
    expect(captured.messages[0].role).toBe('system');
    expect(captured.messages[1].role).toBe('user');
  });

  test('reflectOnBasin rejects bad provider', async () => {
    await expect(reflectOnBasin({ pattern: 'x' }, [], null)).rejects.toThrow(/llmProvider/);
    await expect(reflectOnBasin({ pattern: 'x' }, [], {})).rejects.toThrow(/chat/);
  });

  test('reflectOnBasin handles non-JSON response gracefully', async () => {
    const mockLlm = {
      describe() { return { provider: 'mock', baseUrl: 'mock', defaultModel: 'm' }; },
      async chat() {
        return { content: 'the model just talked', model: 'mock-model', finishReason: 'stop' };
      },
    };
    const result = await reflectOnBasin({ pattern: 'x', sampleHandoffIds: [], rawSamples: [], agents: [], taskTypes: [], projects: [] }, [], mockLlm);
    expect(result.parseFailed).toBe(true);
    expect(result.rootCause).toBe('');
  });
});
