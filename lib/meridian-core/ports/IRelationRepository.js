'use strict';

/**
 * IRelationRepository — port for entry-relation graph operations.
 *
 * Closes the boundary-audit (2026-05-12) finding that graph-engine.js
 * existed but wasn't a typed contract. The graph operations are distinct
 * from IEntryRepository (which handles entry CRUD): this port wraps the
 * read-side graph queries (neighbors, paths, contradictions, stats) plus
 * the heuristic auto-edge detector.
 *
 * Cockburn 2005 hexagonal: core defines what it needs; adapters deliver it.
 *
 * @abstract
 */
class IRelationRepository {
  /**
   * Direct neighbors of an entry across the relationship graph.
   *
   * @param {string} projectId
   * @param {string} entryId
   * @returns {Array<{ project, id, name?, type, weight? }>} neighbors with edge metadata
   */
  getNeighbors(projectId, entryId) {
    throw new Error('not implemented: IRelationRepository#getNeighbors');
  }

  /**
   * Edges marked as contradictions (entries flagging conflicting claims).
   *
   * @param {string} [projectId]  Filter to a single project; if omitted, returns cross-project contradictions.
   * @returns {Array<object>}
   */
  getContradictions(projectId) {
    throw new Error('not implemented: IRelationRepository#getContradictions');
  }

  /**
   * Shortest path between two entries via BFS.
   *
   * @returns {Array<string>|null}  Array of "project|id" keys; null if no path.
   */
  findPath(fromProject, fromId, toProject, toId) {
    throw new Error('not implemented: IRelationRepository#findPath');
  }

  /**
   * All shortest paths between two entries up to maxDepth.
   *
   * @param {number} [maxDepth=5]
   * @returns {Array<Array<string>>}  Each element is a path; empty if unreachable.
   */
  findAllShortestPaths(fromProject, fromId, toProject, toId, maxDepth) {
    throw new Error('not implemented: IRelationRepository#findAllShortestPaths');
  }

  /**
   * Detect candidate auto-edges within a project from name/keyword overlap.
   * Returns proposed edges, NOT persisted ones — caller decides whether to write.
   *
   * @returns {Array<{ fromId, toId, type, score, reason }>}
   */
  detectAutoEdges(projectId) {
    throw new Error('not implemented: IRelationRepository#detectAutoEdges');
  }

  /**
   * Aggregate graph stats — node count, edge count, optional hubs and category breakdown.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.withHubs]
   * @param {boolean} [opts.withBreakdown]
   * @returns {object}
   */
  getStats(opts) {
    throw new Error('not implemented: IRelationRepository#getStats');
  }
}

module.exports = { IRelationRepository };
