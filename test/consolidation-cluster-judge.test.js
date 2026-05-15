'use strict';

const {
  buildSystemPrompt,
  buildUserPrompt,
  tryParseJson,
  normalizeJudgement,
  judgeCluster,
} = require('../lib/consolidation/cluster-judge');

describe('cluster-judge / buildSystemPrompt', () => {
  test('mentions JSON-only output and conservative duplicate detection', () => {
    const sys = buildSystemPrompt();
    expect(sys).toMatch(/JSON/);
    expect(sys).toMatch(/conservative/i);
    expect(sys).toMatch(/canonical/i);
    expect(sys).toMatch(/perEntryNotes/);
  });
});

describe('cluster-judge / buildUserPrompt', () => {
  test('embeds full entries (id + name + description), not just summaries', () => {
    const cluster = { id: 'c1', category: 'decisions', project: 'recall-dev', avgSimilarity: 0.85 };
    const entries = [
      { id: 'e1', name: 'first', description: 'full description one' },
      { id: 'e2', name: 'second', description: 'full description two' },
    ];
    const prompt = buildUserPrompt(cluster, entries);
    expect(prompt).toContain('e1');
    expect(prompt).toContain('full description one');
    expect(prompt).toContain('e2');
    expect(prompt).toContain('0.85');
  });
});

describe('cluster-judge / tryParseJson', () => {
  test('handles raw, fenced, and embedded JSON', () => {
    expect(tryParseJson('{"isDuplicate":true}')).toEqual({ isDuplicate: true });
    expect(tryParseJson('```json\n{"isDuplicate":false}\n```')).toEqual({ isDuplicate: false });
    expect(tryParseJson('prefix {"x":1} suffix')).toEqual({ x: 1 });
    expect(tryParseJson('not json')).toBeNull();
    expect(tryParseJson(null)).toBeNull();
  });
});

describe('cluster-judge / normalizeJudgement', () => {
  test('marks parseFailed when input is null', () => {
    const out = normalizeJudgement(null, 'm');
    expect(out.parseFailed).toBe(true);
    expect(out.isDuplicate).toBe(false);
    expect(out.confidence).toBe(0);
    expect(out.synthesis).toBeNull();
  });

  test('clamps confidence to [0,1]', () => {
    expect(normalizeJudgement({ isDuplicate: true, confidence: 1.5 }, 'm').confidence).toBe(1);
    expect(normalizeJudgement({ isDuplicate: true, confidence: -0.3 }, 'm').confidence).toBe(0);
  });

  test('synthesis only set when isDuplicate=true AND name + description present', () => {
    expect(normalizeJudgement({
      isDuplicate: false,
      synthesis: { name: 'x', description: 'y' },
    }, 'm').synthesis).toBeNull();

    expect(normalizeJudgement({
      isDuplicate: true,
      synthesis: { name: 'x' }, // missing description
    }, 'm').synthesis).toBeNull();

    expect(normalizeJudgement({
      isDuplicate: true,
      synthesis: { name: 'x', description: 'y' },
    }, 'm').synthesis).toEqual({ name: 'x', description: 'y' });
  });

  test('perEntryNotes accepts only valid roles, defaults invalid to "partial"', () => {
    const out = normalizeJudgement({
      isDuplicate: true,
      synthesis: { name: 'x', description: 'y' },
      perEntryNotes: [
        { id: 'e1', role: 'canonical', note: 'best version' },
        { id: 'e2', role: 'redundant', note: 'covered' },
        { id: 'e3', role: 'invalid-role', note: 'edge case' },
        { id: 'e4' }, // missing role
        { role: 'canonical' }, // missing id — should be filtered out
      ],
    }, 'm');
    expect(out.perEntryNotes).toHaveLength(4);
    expect(out.perEntryNotes.find((n) => n.id === 'e1').role).toBe('canonical');
    expect(out.perEntryNotes.find((n) => n.id === 'e3').role).toBe('partial');
    expect(out.perEntryNotes.find((n) => n.id === 'e4').role).toBe('partial');
  });
});

describe('cluster-judge / judgeCluster', () => {
  test('rejects invalid inputs', async () => {
    const llm = { async chat() { return { content: '{}', model: 'm' }; } };
    await expect(judgeCluster(null, [{ id: 'x' }], llm)).rejects.toThrow(/cluster/);
    await expect(judgeCluster({ id: 'c1' }, [], llm)).rejects.toThrow(/entries/);
    await expect(judgeCluster({ id: 'c1' }, [{ id: 'x' }], null)).rejects.toThrow(/llmProvider/);
    await expect(judgeCluster({ id: 'c1' }, [{ id: 'x' }], {})).rejects.toThrow(/llmProvider/);
  });

  test('happy path: parses LLM response into judgement', async () => {
    let captured;
    const llm = {
      async chat(req) {
        captured = req;
        return {
          content: JSON.stringify({
            isDuplicate: true,
            confidence: 0.9,
            synthesis: { name: 'canonical name', description: 'unified description' },
            rationale: 'both entries describe the same sandbox failure',
            perEntryNotes: [
              { id: 'e1', role: 'canonical', note: 'cleanest statement' },
              { id: 'e2', role: 'redundant', note: 'same content, fewer details' },
            ],
          }),
          model: 'mock-model',
          finishReason: 'stop',
        };
      },
    };
    const result = await judgeCluster(
      { id: 'c1', avgSimilarity: 0.8 },
      [{ id: 'e1', name: 'a', description: 'b' }, { id: 'e2', name: 'a', description: 'c' }],
      llm,
    );
    expect(result.isDuplicate).toBe(true);
    expect(result.confidence).toBe(0.9);
    expect(result.synthesis.name).toBe('canonical name');
    expect(result.perEntryNotes).toHaveLength(2);
    expect(result.parseFailed).toBe(false);
    expect(captured.json).toBe(true);
    expect(captured.messages[0].role).toBe('system');
  });

  test('handles non-JSON LLM response gracefully', async () => {
    const llm = { async chat() { return { content: 'the model just rambled', model: 'm', finishReason: 'stop' }; } };
    const result = await judgeCluster(
      { id: 'c1', avgSimilarity: 0.7 },
      [{ id: 'e1', name: 'a', description: 'b' }],
      llm,
    );
    expect(result.parseFailed).toBe(true);
    expect(result.isDuplicate).toBe(false);
  });
});
