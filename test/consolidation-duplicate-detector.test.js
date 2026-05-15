'use strict';

const {
  STOP_WORDS,
  tokenize,
  jaccard,
  scoreEntryPair,
  clusterDuplicates,
} = require('../lib/consolidation/duplicate-detector');

describe('duplicate-detector / tokenize', () => {
  test('lowercases, strips punctuation, drops short tokens and stop words', () => {
    const tokens = tokenize('The Quick Brown Fox jumps! Over a lazy Dog.');
    expect(tokens.has('quick')).toBe(true);
    expect(tokens.has('brown')).toBe(true);
    expect(tokens.has('jumps')).toBe(true);
    expect(tokens.has('lazy')).toBe(true);
    expect(tokens.has('dog')).toBe(true);
    expect(tokens.has('the')).toBe(false);
    expect(tokens.has('a')).toBe(false);
    // 'over' is NOT a stop word in the minimal default list; it's a real lexeme.
    expect(tokens.has('over')).toBe(true);
  });

  test('handles null/empty/undefined', () => {
    expect(tokenize(null).size).toBe(0);
    expect(tokenize('').size).toBe(0);
    expect(tokenize(undefined).size).toBe(0);
  });

  test('STOP_WORDS includes common English connectives', () => {
    expect(STOP_WORDS.has('the')).toBe(true);
    expect(STOP_WORDS.has('and')).toBe(true);
    expect(STOP_WORDS.has('have')).toBe(true);
  });
});

describe('duplicate-detector / jaccard', () => {
  test('identical sets → 1.0', () => {
    expect(jaccard(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'c']))).toBe(1);
  });

  test('disjoint sets → 0', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['c', 'd']))).toBe(0);
  });

  test('half overlap → 1/3 (intersection 1, union 3)', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3, 4);
  });

  test('both empty → 0', () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});

describe('duplicate-detector / scoreEntryPair', () => {
  test('identical entries → 1.0', () => {
    const e = { name: 'foo bar baz', description: 'qux quux quuux' };
    expect(scoreEntryPair(e, e)).toBe(1);
  });

  test('different name + different description → 0', () => {
    expect(scoreEntryPair(
      { name: 'apple', description: 'fruit' },
      { name: 'tractor', description: 'machine' },
    )).toBe(0);
  });

  test('default weights: name=0.6, description=0.4', () => {
    const a = { name: 'shared name tokens here', description: 'totally different body' };
    const b = { name: 'shared name tokens here', description: 'wholly unrelated content' };
    const score = scoreEntryPair(a, b);
    // names identical (1.0), descriptions disjoint (0.0)
    // 0.6 * 1 + 0.4 * 0 = 0.6
    expect(score).toBe(0.6);
  });

  test('custom weights are respected', () => {
    const a = { name: 'same name', description: 'apple' };
    const b = { name: 'same name', description: 'banana' };
    expect(scoreEntryPair(a, b, { nameWeight: 1.0 })).toBe(1);
    expect(scoreEntryPair(a, b, { nameWeight: 0 })).toBe(0);
  });
});

describe('duplicate-detector / clusterDuplicates', () => {
  test('returns empty clusters when input has < 2 entries', () => {
    expect(clusterDuplicates([]).clusters).toEqual([]);
    expect(clusterDuplicates([{ id: 'x', name: 'n', description: 'd' }]).clusters).toEqual([]);
  });

  test('detects an obvious cluster above threshold', () => {
    const entries = [
      { id: 'a', name: 'sandbox eperm spawn blocked', description: 'sandbox prevented child process spawn' },
      { id: 'b', name: 'sandbox eperm spawn blocked', description: 'child spawn blocked by sandbox' },
      { id: 'c', name: 'completely unrelated thing', description: 'about something else entirely' },
    ];
    const result = clusterDuplicates(entries, { threshold: 0.5 });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].memberIds.sort()).toEqual(['a', 'b']);
    expect(result.clusters[0].avgSimilarity).toBeGreaterThan(0.5);
  });

  test('transitive clustering: a~b, b~c, but not a~c → all three cluster', () => {
    const entries = [
      { id: 'a', name: 'alpha beta', description: 'shared body content here' },
      { id: 'b', name: 'beta gamma', description: 'shared body content here' },
      { id: 'c', name: 'gamma delta', description: 'shared body content here' },
    ];
    const result = clusterDuplicates(entries, { threshold: 0.3 });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].memberIds.sort()).toEqual(['a', 'b', 'c']);
  });

  test('higher threshold filters more aggressively', () => {
    const entries = [
      { id: 'a', name: 'mostly similar name', description: 'somewhat similar body' },
      { id: 'b', name: 'mostly similar name', description: 'different body content' },
    ];
    const lowThresh = clusterDuplicates(entries, { threshold: 0.3 });
    const highThresh = clusterDuplicates(entries, { threshold: 0.95 });
    expect(lowThresh.clusters.length).toBeGreaterThanOrEqual(highThresh.clusters.length);
  });

  test('reports scanned + comparisons counts', () => {
    const entries = [
      { id: 'a', name: 'a', description: 'a' },
      { id: 'b', name: 'b', description: 'b' },
      { id: 'c', name: 'c', description: 'c' },
    ];
    const result = clusterDuplicates(entries, { threshold: 0.5 });
    expect(result.scanned).toBe(3);
    expect(result.comparisons).toBe(3); // 3 choose 2
  });

  test('clusters sort by avgSimilarity desc', () => {
    const entries = [
      { id: 'a1', name: 'low low low', description: 'matches a' },
      { id: 'a2', name: 'low low low', description: 'matches a' },
      { id: 'b1', name: 'high high high high', description: 'matches b precisely' },
      { id: 'b2', name: 'high high high high', description: 'matches b precisely' },
    ];
    const result = clusterDuplicates(entries, { threshold: 0.5 });
    expect(result.clusters).toHaveLength(2);
    expect(result.clusters[0].avgSimilarity).toBeGreaterThanOrEqual(result.clusters[1].avgSimilarity);
  });

  test('cluster summary includes id, name, descriptionPreview', () => {
    const entries = [
      { id: 'long-id-a', name: 'matching name x', description: 'desc x' },
      { id: 'long-id-b', name: 'matching name x', description: 'desc x variant' },
    ];
    const result = clusterDuplicates(entries, { threshold: 0.3 });
    expect(result.clusters).toHaveLength(1);
    const summary = result.clusters[0].memberSummaries[0];
    expect(summary).toEqual(expect.objectContaining({
      id: expect.any(String),
      name: expect.any(String),
      descriptionPreview: expect.any(String),
    }));
  });
});
