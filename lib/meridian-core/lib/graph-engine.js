'use strict';

/**
 * GraphEngine — relationship graph queries over a KBStore SQLite database.
 *
 * The relationships table schema (from KBStore._initDb):
 *   fromProject TEXT, fromId TEXT, toProject TEXT, toId TEXT, type TEXT
 *   PRIMARY KEY (fromProject, fromId, toProject, toId)
 *
 * The entries table schema:
 *   id TEXT, projectId TEXT, name TEXT, description TEXT, status TEXT,
 *   category TEXT, tags TEXT, disease_area TEXT, genes TEXT, pathways TEXT,
 *   addedAt TEXT, updatedAt TEXT
 *   PRIMARY KEY (projectId, id)
 */
class GraphEngine {
  /**
   * @param {import('better-sqlite3').Database} db  SQLite db from KBStore.db
   */
  constructor(db) {
    this.db = db;
  }

  // ---------------------------------------------------------------------------
  // getNeighbors(projectId, entryId)
  // Returns all relationship rows where this entry appears as from or to.
  // ---------------------------------------------------------------------------
  getNeighbors(projectId, entryId) {
    return this.db.prepare(`
      SELECT * FROM relationships
      WHERE (fromProject = ? AND fromId = ?)
         OR (toProject   = ? AND toId   = ?)
    `).all(projectId, entryId, projectId, entryId);
  }

  // ---------------------------------------------------------------------------
  // getContradictions(projectId?)
  // Returns all relationships of type='contradicts', optionally filtered by
  // project. Includes from_name and to_name via join with entries table.
  // ---------------------------------------------------------------------------
  getContradictions(projectId) {
    if (projectId !== undefined) {
      return this.db.prepare(`
        SELECT r.*,
               ef.name AS from_name,
               et.name AS to_name
        FROM relationships r
        LEFT JOIN entries ef ON ef.projectId = r.fromProject AND ef.id = r.fromId
        LEFT JOIN entries et ON et.projectId = r.toProject   AND et.id = r.toId
        WHERE r.type = 'contradicts'
          AND (r.fromProject = ? OR r.toProject = ?)
      `).all(projectId, projectId);
    }

    return this.db.prepare(`
      SELECT r.*,
             ef.name AS from_name,
             et.name AS to_name
      FROM relationships r
      LEFT JOIN entries ef ON ef.projectId = r.fromProject AND ef.id = r.fromId
      LEFT JOIN entries et ON et.projectId = r.toProject   AND et.id = r.toId
      WHERE r.type = 'contradicts'
    `).all();
  }

  // ---------------------------------------------------------------------------
  // findPath(fromProject, fromId, toProject, toId)
  // BFS through the undirected relationship graph.
  // Returns an array of "projectId:entryId" strings forming the path,
  // or null if no path exists.
  // ---------------------------------------------------------------------------
  findPath(fromProject, fromId, toProject, toId) {
    const startKey = `${fromProject}:${fromId}`;
    const endKey   = `${toProject}:${toId}`;

    // Trivial: same node
    if (startKey === endKey) return [startKey];

    // BFS
    const visited = new Set([startKey]);
    const queue   = [[startKey]]; // each element is a path array

    while (queue.length > 0) {
      const currentPath = queue.shift();
      const currentKey  = currentPath[currentPath.length - 1];
      const [curProj, curId] = currentKey.split(':');

      // Fetch all edges touching this node (undirected)
      const edges = this.db.prepare(`
        SELECT fromProject, fromId, toProject, toId FROM relationships
        WHERE (fromProject = ? AND fromId = ?)
           OR (toProject   = ? AND toId   = ?)
      `).all(curProj, curId, curProj, curId);

      for (const edge of edges) {
        // Determine the neighbor key (the other end of the edge)
        let neighborKey;
        if (edge.fromProject === curProj && edge.fromId === curId) {
          neighborKey = `${edge.toProject}:${edge.toId}`;
        } else {
          neighborKey = `${edge.fromProject}:${edge.fromId}`;
        }

        if (visited.has(neighborKey)) continue;
        visited.add(neighborKey);

        const newPath = [...currentPath, neighborKey];

        if (neighborKey === endKey) return newPath;

        queue.push(newPath);
      }
    }

    return null; // no path found
  }

  // ---------------------------------------------------------------------------
  // findAllShortestPaths(fromProject, fromId, toProject, toId, maxDepth = 5)
  //
  // Returns ALL shortest paths between two nodes (vs. findPath which returns
  // one). BFS to first depth that contains the target, then collects every
  // path at that depth.
  //
  // Adapted from ~/.recall/lib/graph-engine.js findPaths(). Multi-path
  // capability is useful for "show me all the ways A connects to B" — the
  // most direct routes (paths of equal minimum length) all surface together.
  //
  // Returns: array of paths, each path = array of "projectId:entryId" strings.
  //          Empty array if no path within maxDepth.
  // ---------------------------------------------------------------------------
  findAllShortestPaths(fromProject, fromId, toProject, toId, maxDepth = 5) {
    const startKey = `${fromProject}:${fromId}`;
    const endKey   = `${toProject}:${toId}`;
    if (startKey === endKey) return [[startKey]];

    const stmt = this.db.prepare(`
      SELECT fromProject, fromId, toProject, toId FROM relationships
      WHERE (fromProject = ? AND fromId = ?)
         OR (toProject   = ? AND toId   = ?)
    `);

    const queue = [[startKey]];
    const results = [];
    let foundDepth = Infinity;

    while (queue.length > 0) {
      const path = queue.shift();
      if (path.length > maxDepth) continue;
      if (path.length > foundDepth) continue;

      const currentKey = path[path.length - 1];
      const [curProj, curId] = currentKey.split(':');
      const edges = stmt.all(curProj, curId, curProj, curId);

      for (const edge of edges) {
        const neighborKey = (edge.fromProject === curProj && edge.fromId === curId)
          ? `${edge.toProject}:${edge.toId}`
          : `${edge.fromProject}:${edge.fromId}`;

        if (path.includes(neighborKey)) continue;  // no cycles
        const newPath = [...path, neighborKey];

        if (newPath.length > maxDepth) continue;  // hard cap on path length

        if (neighborKey === endKey) {
          if (newPath.length <= foundDepth) {
            foundDepth = newPath.length;
            results.push(newPath);
          }
        } else if (newPath.length < foundDepth) {
          queue.push(newPath);
        }
      }
    }

    return results.sort((a, b) => a.length - b.length);
  }

  // ---------------------------------------------------------------------------
  // detectAutoEdges(projectId)
  //
  // Scans descriptions of active entries in the project for mentions of
  // OTHER entries' names (≥5 chars, longest-first to avoid partial matches).
  // Returns candidate edges that don't already exist in `relationships`.
  // Caller decides whether to insert.
  //
  // Adapted from ~/.recall/lib/graph-engine.js. Opt-in (caller invokes when
  // wanting a refreshed candidate set) — not auto-run on every read.
  // ---------------------------------------------------------------------------
  detectAutoEdges(projectId) {
    const entries = this.db.prepare(
      "SELECT id, name, description FROM entries WHERE projectId = ? AND status = 'active'"
    ).all(projectId);

    const nameToId = {};
    for (const e of entries) {
      if (e.name && e.name.length >= 5) nameToId[e.name] = e.id;
    }

    // longest-name-first ordering avoids partial-match collisions
    // (e.g., "Foo Bar" matches before "Foo")
    const namePairs = Object.entries(nameToId).sort((a, b) => b[0].length - a[0].length);

    // Build set of existing edges to dedupe candidates
    const existing = new Set();
    const existingRows = this.db.prepare(
      'SELECT fromId, toId FROM relationships WHERE fromProject = ? AND toProject = ?'
    ).all(projectId, projectId);
    for (const r of existingRows) existing.add(`${r.fromId}|${r.toId}`);

    const candidates = [];
    for (const e of entries) {
      const desc = (e.description || '').toLowerCase();
      if (!desc) continue;

      for (const [name, targetId] of namePairs) {
        if (targetId === e.id) continue;
        if (existing.has(`${e.id}|${targetId}`)) continue;
        if (desc.includes(name.toLowerCase())) {
          candidates.push({
            fromProject: projectId, fromId: e.id,
            toProject: projectId, toId: targetId,
            type: 'related',
            auto: true,
          });
          existing.add(`${e.id}|${targetId}`);  // dedup within this run
        }
      }
    }

    return candidates;
  }

  // ---------------------------------------------------------------------------
  // getStats({ withHubs, withBreakdown })
  // Returns { nodeCount, edgeCount, contradictionCount } by default.
  // - withHubs:      adds `hubs[]` (top 5 nodes by total connections)
  // - withBreakdown: adds `byProject` and `byType` counts
  //
  // Backwards-compatible: getStats() with no args returns the original shape.
  // ---------------------------------------------------------------------------
  getStats({ withHubs = false, withBreakdown = false } = {}) {
    const { nodeCount } = this.db.prepare(
      'SELECT COUNT(*) AS nodeCount FROM entries'
    ).get();

    const { edgeCount } = this.db.prepare(
      'SELECT COUNT(*) AS edgeCount FROM relationships'
    ).get();

    const { contradictionCount } = this.db.prepare(
      "SELECT COUNT(*) AS contradictionCount FROM relationships WHERE type = 'contradicts'"
    ).get();

    const out = { nodeCount, edgeCount, contradictionCount };

    if (withBreakdown) {
      const byProject = {};
      for (const r of this.db.prepare(
        'SELECT projectId, COUNT(*) AS c FROM entries GROUP BY projectId'
      ).all()) {
        byProject[r.projectId] = r.c;
      }
      const byType = {};
      for (const r of this.db.prepare(
        'SELECT category, COUNT(*) AS c FROM entries GROUP BY category'
      ).all()) {
        byType[r.category || 'unknown'] = r.c;
      }
      out.byProject = byProject;
      out.byType = byType;
    }

    if (withHubs) {
      // Top 5 nodes by total connections (in + out, both directions counted)
      out.hubs = this.db.prepare(`
        SELECT e.id, e.name AS label, e.projectId, COUNT(*) AS connections
        FROM entries e
        JOIN relationships r
          ON (r.fromId = e.id AND r.fromProject = e.projectId)
          OR (r.toId   = e.id AND r.toProject   = e.projectId)
        GROUP BY e.projectId, e.id
        ORDER BY connections DESC
        LIMIT 5
      `).all();
    }

    return out;
  }
}

module.exports = { GraphEngine };
