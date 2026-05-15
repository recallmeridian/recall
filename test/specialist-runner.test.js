'use strict';

const {
  REQUIRED_MANIFEST_FIELDS,
  SpecialistManifestError,
  validateManifest,
  executeRetrieval,
  tryParseJson,
  runSpecialist,
} = require('../lib/specialist-runner');

function validSpecialist(overrides = {}) {
  return {
    id: 'test-specialist',
    version: '0.1.0',
    name: 'Test',
    description: 'A test specialist',
    declaredCapabilities: ['call_llm'],
    requiredPorts: ['ILLMProvider'],
    promptTemplates: {
      system: 'You are a test.',
      user: ({ input }) => `Input: ${input}`,
    },
    retrievalRecipe: { queries: [{ category: 'decisions', limit: 5 }] },
    outputSchema: { type: 'object' },
    ...overrides,
  };
}

describe('specialist-runner / validateManifest', () => {
  test('REQUIRED_MANIFEST_FIELDS includes the load-bearing fields', () => {
    for (const f of ['id', 'version', 'name', 'promptTemplates', 'retrievalRecipe', 'outputSchema']) {
      expect(REQUIRED_MANIFEST_FIELDS).toContain(f);
    }
  });

  test('passes for a fully-specified bundle', () => {
    expect(() => validateManifest(validSpecialist())).not.toThrow();
  });

  test('throws SpecialistManifestError for missing required fields', () => {
    expect(() => validateManifest({})).toThrow(SpecialistManifestError);
    try { validateManifest({ id: 'x' }); } catch (err) {
      expect(err.fieldErrors.length).toBeGreaterThan(0);
    }
  });

  test('rejects invalid id format', () => {
    try { validateManifest(validSpecialist({ id: 'Bad ID With Spaces' })); }
    catch (err) {
      expect(err).toBeInstanceOf(SpecialistManifestError);
      expect(err.fieldErrors.join(' ')).toMatch(/lowercase alphanumeric/);
      return;
    }
    throw new Error('expected throw');
  });

  test('rejects invalid semver version', () => {
    try { validateManifest(validSpecialist({ version: '1.0' })); }
    catch (err) {
      expect(err.fieldErrors.join(' ')).toMatch(/semver/);
      return;
    }
    throw new Error('expected throw');
  });

  test('rejects promptTemplates without system string', () => {
    try { validateManifest(validSpecialist({ promptTemplates: { user: () => 'x' } })); }
    catch (err) {
      expect(err.fieldErrors.join(' ')).toMatch(/system/);
      return;
    }
    throw new Error('expected throw');
  });

  test('rejects promptTemplates without user function', () => {
    try { validateManifest(validSpecialist({ promptTemplates: { system: 'hi', user: 'not a function' } })); }
    catch (err) {
      expect(err.fieldErrors.join(' ')).toMatch(/user must be a function/);
      return;
    }
    throw new Error('expected throw');
  });
});

describe('specialist-runner / executeRetrieval', () => {
  test('returns empty for missing recipe', async () => {
    expect(await executeRetrieval(null, {})).toEqual([]);
    expect(await executeRetrieval({}, {})).toEqual([]);
  });

  test('returns empty when kb lacks listEntries', async () => {
    expect(await executeRetrieval({ queries: [{ category: 'x' }] }, null)).toEqual([]);
    expect(await executeRetrieval({ queries: [{ category: 'x' }] }, {})).toEqual([]);
  });

  test('calls kb.listEntries for each query and aggregates results', async () => {
    const calls = [];
    const kb = {
      listEntries(project, category, opts) {
        calls.push({ project, category, opts });
        return [
          { id: `${category}-1`, name: `name-${category}`, description: 'desc' },
          { id: `${category}-2`, name: 'other', description: 'desc2' },
        ];
      },
    };
    const result = await executeRetrieval({
      defaultProject: 'recall-dev',
      queries: [
        { category: 'decisions', limit: 5 },
        { category: 'lessons', limit: 3 },
      ],
    }, kb);

    expect(calls).toHaveLength(2);
    expect(calls[0].project).toBe('recall-dev');
    expect(calls[0].category).toBe('decisions');
    expect(calls[1].category).toBe('lessons');
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual(expect.objectContaining({
      category: 'decisions',
      project: 'recall-dev',
      id: 'decisions-1',
    }));
  });

  test('skips throws and keeps going', async () => {
    const kb = {
      listEntries(project, category) {
        if (category === 'bad') throw new Error('boom');
        return [{ id: `${category}-ok`, name: 'ok', description: 'ok' }];
      },
    };
    const result = await executeRetrieval({
      queries: [{ category: 'bad' }, { category: 'good' }],
    }, kb, { project: 'p' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('good-ok');
  });

  test('opts.project overrides recipe defaultProject', async () => {
    const calls = [];
    const kb = { listEntries(p, c) { calls.push(p); return []; } };
    await executeRetrieval({
      defaultProject: 'recall-dev',
      queries: [{ category: 'decisions' }],
    }, kb, { project: 'sample-bot-project' });
    expect(calls[0]).toBe('sample-bot-project');
  });
});

describe('specialist-runner / tryParseJson', () => {
  test('handles raw / fenced / embedded JSON', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(tryParseJson('prefix {"a":3} suffix')).toEqual({ a: 3 });
    expect(tryParseJson('not json')).toBeNull();
    expect(tryParseJson(null)).toBeNull();
  });
});

describe('specialist-runner / runSpecialist', () => {
  test('throws on invalid manifest before calling LLM', async () => {
    const calls = [];
    const llm = { async chat(r) { calls.push(r); return { content: '{}', model: 'm' }; } };
    await expect(runSpecialist({}, 'input', { llmProvider: llm }))
      .rejects.toThrow(SpecialistManifestError);
    expect(calls).toHaveLength(0);
  });

  test('throws when llmProvider missing or invalid', async () => {
    await expect(runSpecialist(validSpecialist(), 'x', {})).rejects.toThrow(/llmProvider/);
    await expect(runSpecialist(validSpecialist(), 'x', { llmProvider: {} })).rejects.toThrow(/llmProvider/);
  });

  test('happy path: builds prompt with retrieved context, calls LLM, parses result', async () => {
    let captured;
    const llm = {
      async chat(req) {
        captured = req;
        return {
          content: JSON.stringify({ summary: 'looks fine', warnings: [], riskLevel: 'low', confidence: 0.7 }),
          model: 'mock-model',
          finishReason: 'stop',
        };
      },
    };
    const kb = {
      listEntries() { return [{ id: 'd1', name: 'past decision', description: 'do not do X' }]; },
    };
    const result = await runSpecialist(validSpecialist(), 'review this change', { llmProvider: llm, kb });
    expect(result.specialistId).toBe('test-specialist');
    expect(result.specialistVersion).toBe('0.1.0');
    expect(result.retrievedContextCount).toBe(1);
    expect(result.parseFailed).toBe(false);
    expect(result.output.summary).toBe('looks fine');
    expect(result.model).toBe('mock-model');
    expect(captured.messages[0].role).toBe('system');
    expect(captured.messages[0].content).toBe('You are a test.');
    expect(captured.messages[1].role).toBe('user');
    expect(captured.messages[1].content).toContain('review this change');
    expect(captured.json).toBe(true);
  });

  test('marks parseFailed when LLM returns garbage', async () => {
    const llm = {
      async chat() { return { content: 'no json here', model: 'm', finishReason: 'stop' }; },
    };
    const result = await runSpecialist(validSpecialist(), 'x', { llmProvider: llm });
    expect(result.parseFailed).toBe(true);
    expect(result.output).toBeNull();
  });

  test('opts.includeRetrievedContext attaches retrieved entries to result', async () => {
    const llm = { async chat() { return { content: '{}', model: 'm', finishReason: 'stop' }; } };
    const kb = { listEntries() { return [{ id: 'd1', name: 'n', description: 'd' }]; } };
    const result = await runSpecialist(validSpecialist(), 'x', { llmProvider: llm, kb }, { includeRetrievedContext: true });
    expect(Array.isArray(result.retrievedContext)).toBe(true);
    expect(result.retrievedContext[0].id).toBe('d1');
  });

  test('opts.json=false disables JSON-mode passthrough', async () => {
    let captured;
    const llm = { async chat(req) { captured = req; return { content: '{}', model: 'm', finishReason: 'stop' }; } };
    await runSpecialist(validSpecialist(), 'x', { llmProvider: llm }, { json: false });
    expect(captured.json).toBe(false);
  });
});

describe('specialist-runner / recall-dev-codebase-reviewer bundle', () => {
  test('the bundle loads and passes manifest validation', () => {
    const mod = require('../lib/specialists/recall-dev-codebase-reviewer');
    expect(mod.id).toBe('recall-dev-codebase-reviewer');
    expect(mod.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(() => validateManifest(mod.specialist)).not.toThrow();
  });

  test('the bundle has at least 3 evaluation cases', () => {
    const mod = require('../lib/specialists/recall-dev-codebase-reviewer');
    expect(mod.specialist.evaluationCases.length).toBeGreaterThanOrEqual(3);
    for (const c of mod.specialist.evaluationCases) {
      expect(c.id).toBeTruthy();
      expect(c.input).toBeTruthy();
      expect(c.expected).toBeTruthy();
    }
  });

  test('the bundle\'s user-message builder embeds the input and retrieved entries', () => {
    const mod = require('../lib/specialists/recall-dev-codebase-reviewer');
    const msg = mod.specialist.promptTemplates.user({
      input: 'feat: do thing',
      retrievedContext: [
        { category: 'decisions', project: 'recall-dev', id: 'd-1', name: 'past decision', description: 'do not do X' },
      ],
    });
    expect(msg).toContain('feat: do thing');
    expect(msg).toContain('d-1');
    expect(msg).toContain('do not do X');
    expect(msg).toContain('decisions');
  });

  test('the bundle gracefully handles empty retrievedContext', () => {
    const mod = require('../lib/specialists/recall-dev-codebase-reviewer');
    const msg = mod.specialist.promptTemplates.user({ input: 'change', retrievedContext: [] });
    expect(msg).toContain('No related KB entries');
    expect(msg).not.toContain('undefined');
  });
});

describe('specialist-runner / recall-marketing-strategist bundle', () => {
  test('the bundle loads and passes manifest validation', () => {
    const mod = require('../lib/specialists/recall-marketing-strategist');
    expect(mod.id).toBe('recall-marketing-strategist');
    expect(mod.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(() => validateManifest(mod.specialist)).not.toThrow();
  });

  test('the bundle encodes truthfulness and automation-gap evals', () => {
    const mod = require('../lib/specialists/recall-marketing-strategist');
    expect(mod.specialist.evaluationCases.length).toBeGreaterThanOrEqual(3);
    const text = JSON.stringify(mod.specialist.evaluationCases);
    expect(text).toContain('automation-gap');
    expect(text).toContain('overclaim');
    expect(text).toContain('observability-gap');
  });

  test('the user-message builder embeds the draft and retrieved context', () => {
    const mod = require('../lib/specialists/recall-marketing-strategist');
    const msg = mod.specialist.promptTemplates.user({
      input: 'Recall makes public @grok remember my private sessions.',
      retrievedContext: [
        { category: 'lessons', project: 'recall-dev', id: 'manual-bridge', description: 'Public X Grok cannot directly access the private Recall MCP; use a manual bridge.' },
      ],
    });
    expect(msg).toContain('public @grok');
    expect(msg).toContain('manual-bridge');
    expect(msg).toContain('manual bridge');
    expect(msg).not.toContain('undefined');
  });
});
