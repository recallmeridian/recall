'use strict';

const {
  evaluateEnsemble,
  rulesEvaluator,
  heuristicEvaluator,
  llmEvaluator,
} = require('../lib/security/evaluator-ensemble');

describe('cross-system evaluator ensemble', () => {
  test('no-evaluators is its own decision class', () => {
    const r = evaluateEnsemble({ subject: { content: 'hi' }, evaluators: [] });
    expect(r.decision).toBe('no-evaluators');
  });

  test('three evaluators all agree → agree-allow', () => {
    const evs = [
      { name: 'a', kind: 'rules',          evaluate: () => ({ decision: 'allow',  confidence: 0.9, rationale: 'a' }) },
      { name: 'b', kind: 'frontier-model', evaluate: () => ({ decision: 'allow',  confidence: 0.8, rationale: 'b' }) },
      { name: 'c', kind: 'heuristic',      evaluate: () => ({ decision: 'allow',  confidence: 0.6, rationale: 'c' }) },
    ];
    const r = evaluateEnsemble({ subject: {}, evaluators: evs });
    expect(r.decision).toBe('agree-allow');
    expect(r.agreement.unanimous).toBe(true);
    expect(r.agreement.conflicts).toHaveLength(0);
  });

  test('any single block from any evaluator → disagree-needs-human', () => {
    const evs = [
      { name: 'a', kind: 'rules',          evaluate: () => ({ decision: 'allow', confidence: 0.9, rationale: 'a' }) },
      { name: 'b', kind: 'frontier-model', evaluate: () => ({ decision: 'block', confidence: 0.8, rationale: 'b' }) },
      { name: 'c', kind: 'heuristic',      evaluate: () => ({ decision: 'allow', confidence: 0.5, rationale: 'c' }) },
    ];
    const r = evaluateEnsemble({ subject: {}, evaluators: evs });
    expect(r.decision).toBe('disagree-needs-human');
    expect(r.reason).toMatch(/at least one evaluator returned block/);
  });

  test('majority allow without any block → agree-allow-by-majority', () => {
    const evs = [
      { name: 'a', kind: 'rules',          evaluate: () => ({ decision: 'allow', confidence: 0.9, rationale: 'a' }) },
      { name: 'b', kind: 'frontier-model', evaluate: () => ({ decision: 'allow', confidence: 0.8, rationale: 'b' }) },
      { name: 'c', kind: 'heuristic',      evaluate: () => ({ decision: 'review', confidence: 0.4, rationale: 'c' }) },
    ];
    const r = evaluateEnsemble({ subject: {}, evaluators: evs });
    expect(r.decision).toBe('agree-allow-by-majority');
    expect(r.agreement.unanimous).toBe(false);
    expect(r.agreement.majority).toBe('allow');
  });

  test('split with no majority and no block → disagree-needs-human', () => {
    const evs = [
      { name: 'a', kind: 'rules',          evaluate: () => ({ decision: 'allow',  confidence: 0.9, rationale: 'a' }) },
      { name: 'b', kind: 'frontier-model', evaluate: () => ({ decision: 'review', confidence: 0.8, rationale: 'b' }) },
    ];
    const r = evaluateEnsemble({ subject: {}, evaluators: evs });
    expect(r.decision).toBe('disagree-needs-human');
  });

  test('evaluator error degrades safely to review verdict', () => {
    const evs = [
      { name: 'a', kind: 'rules', evaluate: () => ({ decision: 'allow', confidence: 0.9, rationale: 'a' }) },
      { name: 'b', kind: 'heuristic', evaluate: () => { throw new Error('boom'); } },
    ];
    const r = evaluateEnsemble({ subject: {}, evaluators: evs });
    const failedVerdict = r.verdicts.find((v) => v.name === 'b');
    expect(failedVerdict.decision).toBe('review');
    expect(failedVerdict.error).toBe('boom');
  });

  test('rulesEvaluator: blockers present → block', () => {
    const r = rulesEvaluator().evaluate({ blockers: [{ detectorId: 'foo' }] });
    expect(r.decision).toBe('block');
  });

  test('rulesEvaluator: external egress target → review', () => {
    const r = rulesEvaluator().evaluate({ egressTarget: 'moltbook:public' });
    expect(r.decision).toBe('review');
  });

  test('rulesEvaluator: clean content → allow', () => {
    const r = rulesEvaluator().evaluate({ content: 'hello' });
    expect(r.decision).toBe('allow');
  });

  test('rulesEvaluator: 3+ warnings → review', () => {
    const r = rulesEvaluator().evaluate({ warnings: [{}, {}, {}] });
    expect(r.decision).toBe('review');
  });

  test('heuristicEvaluator: keyword cluster → review', () => {
    const r = heuristicEvaluator().evaluate({ content: 'this contains password and secret and a token in real prose somewhere' });
    expect(r.decision).toBe('review');
  });

  test('heuristicEvaluator: short clean string → allow', () => {
    const r = heuristicEvaluator().evaluate({ content: 'hello world' });
    expect(r.decision).toBe('allow');
  });

  test('llmEvaluator: passes through verdict from invoke fn', () => {
    const e = llmEvaluator({ name: 'governor', invoke: () => ({ decision: 'review', confidence: 0.7, rationale: 'governor said review' }) });
    const r = e.evaluate({ content: 'whatever' });
    expect(r.decision).toBe('review');
    expect(r.rationale).toBe('governor said review');
  });

  test('three different KINDS of evaluator can compose', () => {
    const evs = [
      rulesEvaluator(),
      heuristicEvaluator(),
      llmEvaluator({ name: 'governor', invoke: () => ({ decision: 'allow', confidence: 0.8, rationale: 'looks fine' }) }),
    ];
    const r = evaluateEnsemble({ subject: { content: 'plain text content' }, evaluators: evs });
    expect(r.verdicts).toHaveLength(3);
    expect(r.verdicts.map((v) => v.kind)).toEqual(['rules', 'heuristic', 'frontier-model']);
  });

  test('all-block triggers agree-block', () => {
    const evs = [
      { name: 'a', kind: 'rules', evaluate: () => ({ decision: 'block', confidence: 1, rationale: 'a' }) },
      { name: 'b', kind: 'heuristic', evaluate: () => ({ decision: 'block', confidence: 1, rationale: 'b' }) },
      { name: 'c', kind: 'frontier-model', evaluate: () => ({ decision: 'block', confidence: 1, rationale: 'c' }) },
    ];
    const r = evaluateEnsemble({ subject: {}, evaluators: evs });
    expect(r.decision).toBe('agree-block');
  });
});
