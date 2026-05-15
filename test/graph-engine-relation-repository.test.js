'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const meridian = require('../lib/meridian-core');
const { IRelationRepository } = require('../lib/meridian-core/ports/IRelationRepository');
const { GraphEngineRelationRepository } = require('../lib/meridian-core/adapters/GraphEngineRelationRepository');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recall-relation-repo-'));
}

describe('IRelationRepository (port contract)', () => {
  test('abstract methods throw not-implemented when called on the base class', () => {
    const port = new IRelationRepository();
    expect(() => port.getNeighbors('p', 'e')).toThrow(/not implemented/);
    expect(() => port.getContradictions('p')).toThrow(/not implemented/);
    expect(() => port.findPath('p', 'a', 'p', 'b')).toThrow(/not implemented/);
    expect(() => port.findAllShortestPaths('p', 'a', 'p', 'b')).toThrow(/not implemented/);
    expect(() => port.detectAutoEdges('p')).toThrow(/not implemented/);
    expect(() => port.getStats()).toThrow(/not implemented/);
  });
});

describe('GraphEngineRelationRepository (adapter)', () => {
  let dir;
  let store;
  let repo;

  beforeEach(() => {
    dir = tempDir();
    store = meridian.init(dir);
    repo = store.getRelationRepository();
  });

  afterEach(() => {
    try { if (store && typeof store.close === 'function') store.close(); } catch (_) { /* noop */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* noop */ }
  });

  test('extends IRelationRepository', () => {
    expect(repo).toBeInstanceOf(IRelationRepository);
  });

  test('constructor rejects neither db nor graphEngine', () => {
    expect(() => new GraphEngineRelationRepository({})).toThrow(/db or opts\.graphEngine/);
  });

  test('store.getRelationRepository() returns the same instance on repeated calls', () => {
    expect(store.getRelationRepository()).toBe(repo);
  });

  test('getStats works on an empty KB without throwing', () => {
    const stats = repo.getStats();
    expect(typeof stats).toBe('object');
    expect(stats).toBeTruthy();
  });

  test('getNeighbors on an unknown entry returns an empty array', () => {
    const out = repo.getNeighbors('nonexistent-project', 'nonexistent-entry');
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBe(0);
  });

  test('getContradictions on an empty project returns an empty array', () => {
    const out = repo.getContradictions('empty-project');
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBe(0);
  });

  test('findPath returns null when there is no path', () => {
    expect(repo.findPath('p1', 'a', 'p2', 'b')).toBeNull();
  });

  test('findAllShortestPaths returns empty array when unreachable', () => {
    const paths = repo.findAllShortestPaths('p1', 'a', 'p2', 'b', 3);
    expect(Array.isArray(paths)).toBe(true);
    expect(paths.length).toBe(0);
  });

  test('detectAutoEdges on an empty project returns an empty array', () => {
    const out = repo.detectAutoEdges('empty-project');
    expect(Array.isArray(out)).toBe(true);
  });
});

describe('GraphEngineRelationRepository — accepts injected graphEngine for tests', () => {
  test('passing opts.graphEngine bypasses the db requirement', () => {
    const stubEngine = {
      getNeighbors() { return [{ project: 'p', id: 'x', type: 'depends_on' }]; },
      getContradictions() { return []; },
      findPath() { return ['p|a', 'p|b']; },
      findAllShortestPaths() { return [['p|a', 'p|b']]; },
      detectAutoEdges() { return [{ fromId: 'a', toId: 'b', type: 'refines', score: 0.8 }]; },
      getStats() { return { nodes: 0, edges: 0 }; },
    };
    const repo = new GraphEngineRelationRepository({ graphEngine: stubEngine });
    expect(repo.getNeighbors('p', 'x')).toEqual([{ project: 'p', id: 'x', type: 'depends_on' }]);
    expect(repo.findPath('p', 'a', 'p', 'b')).toEqual(['p|a', 'p|b']);
    expect(repo.detectAutoEdges('p')[0].score).toBe(0.8);
    expect(repo.getStats()).toEqual({ nodes: 0, edges: 0 });
  });
});
