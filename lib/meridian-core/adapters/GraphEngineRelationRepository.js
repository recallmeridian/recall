'use strict';

// GraphEngineRelationRepository — adapter wrapping the existing GraphEngine
// behind the IRelationRepository contract. Thin facade: signatures preserved,
// behavior delegated. Lets future adapters (e.g., Neo4jRelationRepository,
// or a pgvector-backed one) slot in without touching consumers.

const { IRelationRepository } = require('../ports/IRelationRepository');
const { GraphEngine } = require('../lib/graph-engine');

class GraphEngineRelationRepository extends IRelationRepository {
  /**
   * @param {object} opts
   * @param {object} opts.db   better-sqlite3 db handle (the same one KBStore uses)
   * @param {object} [opts.graphEngine]  Optional pre-built GraphEngine (for tests)
   */
  constructor(opts = {}) {
    super();
    if (!opts.db && !opts.graphEngine) {
      throw new Error('GraphEngineRelationRepository: opts.db or opts.graphEngine is required');
    }
    this.engine = opts.graphEngine || new GraphEngine(opts.db);
  }

  getNeighbors(projectId, entryId) {
    return this.engine.getNeighbors(projectId, entryId);
  }

  getContradictions(projectId) {
    return this.engine.getContradictions(projectId);
  }

  findPath(fromProject, fromId, toProject, toId) {
    return this.engine.findPath(fromProject, fromId, toProject, toId);
  }

  findAllShortestPaths(fromProject, fromId, toProject, toId, maxDepth = 5) {
    return this.engine.findAllShortestPaths(fromProject, fromId, toProject, toId, maxDepth);
  }

  detectAutoEdges(projectId) {
    return this.engine.detectAutoEdges(projectId);
  }

  getStats(opts = {}) {
    return this.engine.getStats(opts);
  }
}

module.exports = { GraphEngineRelationRepository };
