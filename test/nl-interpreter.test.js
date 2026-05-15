'use strict';

const { interpret } = require('../lib/nl-interpreter');

describe('NL interpreter', () => {
  test('interprets search query', () => {
    const result = interpret('show me my Kelly sizing research', 'my-lab');
    expect(result).not.toBeNull();
    expect(result.cmd).toBe('search');
    expect(result.interpretation).toContain('search');
  });

  test('interprets ingest command', () => {
    const result = interpret('ingest this paper 10.1038/s41586-021-03819-2');
    expect(result).not.toBeNull();
    expect(result.cmd).toBe('ingest');
    expect(result.args[0]).toContain('10.1038');
  });

  test('interprets status request', () => {
    const result = interpret('how many entries do I have?');
    expect(result).not.toBeNull();
    expect(result.cmd).toBe('status');
  });

  test('interprets add entry', () => {
    const result = interpret('add a new finding', 'my-lab');
    expect(result).not.toBeNull();
    expect(result.cmd).toBe('add');
  });

  test('interprets push command', () => {
    const result = interpret('share my results to the server', 'my-lab');
    expect(result).not.toBeNull();
    expect(result.cmd).toBe('push');
  });

  test('interprets export', () => {
    const result = interpret('export to markdown', 'my-lab');
    expect(result).not.toBeNull();
    expect(result.cmd).toBe('export');
  });

  test('returns null for gibberish', () => {
    const result = interpret('xyzzy plugh');
    expect(result).toBeNull();
  });

  test('confidence is between 0 and 1', () => {
    const result = interpret('search KRAS resistance', 'lab');
    expect(result).not.toBeNull();
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  test('interprets pull/sync command', () => {
    const result = interpret('pull latest from server');
    expect(result).not.toBeNull();
    expect(result.cmd).toBe('pull');
  });

  test('interprets browse command', () => {
    const result = interpret('browse all entries', 'my-lab');
    expect(result).not.toBeNull();
    expect(result.cmd).toBe('browse');
  });

  test('interprets query command', () => {
    const result = interpret('query TABLE name FROM entries', 'my-lab');
    expect(result).not.toBeNull();
    expect(result.cmd).toBe('query');
  });

  test('returns interpretation string', () => {
    const result = interpret('search KRAS mutations', 'oncology');
    expect(result).not.toBeNull();
    expect(typeof result.interpretation).toBe('string');
    expect(result.interpretation).toMatch(/^meridian /);
  });

  test('returns null for empty input', () => {
    expect(interpret('')).toBeNull();
    expect(interpret('   ')).toBeNull();
    expect(interpret(null)).toBeNull();
  });

  test('multi-word keywords score higher than single keywords', () => {
    // "add paper" is a multi-word keyword for ingest — should score higher than "add" alone
    const result = interpret('add paper 10.1234/test');
    expect(result).not.toBeNull();
    expect(result.cmd).toBe('ingest');
  });
});
