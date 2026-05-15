'use strict';

/**
 * buildLocalRegistry — composition root for local-mode @meridian/core.
 *
 * Wires the local-mode default adapter set:
 *   - signing:    NullSigningService           (no cryptographic verification)
 *   - store:      KBStore                      (file-on-disk JSON + SQLite index)
 *   - repository: KBStoreEntryRepository       (per-project; lazy-constructed via .get('repository', projectId))
 *   - search:     HybridSearchEngine           (BM25 + dense + RRF + reranker, with entry_usage LEFT JOIN)
 *   - graph:      GraphEngine                  (relationships traversal)
 *   - gaps:       GapsEngine                   (sinks/orphans/untestedBeliefs/kinIsolation)
 *   - snapshot:   SnapshotService              (warm-context markdown bundles per project)
 *   - domain:     NullDomainAdapter            (no domain-specific logic)
 *
 * Use:
 *   const { buildLocalRegistry } = require('@meridian/core');
 *   const registry = buildLocalRegistry({ dataDir: '~/.recall/meridian-engine' });
 *   const search   = registry.get('search');
 *   const repo     = registry.get('repository', 'project-id');
 *
 * "Recall = local mode of Meridian" (decision-1776967790010): this factory
 * IS that local mode at the code level. Recall's Phase 1 mcp-server.js
 * calls into here; future researcher-solo or enterprise-private deployments
 * use the same composition root with their own dataDir.
 *
 * @param {object} opts
 * @param {string} opts.dataDir  Required. Absolute path to data directory.
 *                               KBStore stores JSON files at <dataDir>/kb/
 *                               and the SQLite index at <dataDir>/kb/meridian.db.
 * @returns {{ get: (key, ...args) => any, close: () => void }}
 */

const { KBStore } = require('./kb-store');
const { GraphEngine } = require('./graph-engine');
const { GapsEngine } = require('./gaps');
const { SnapshotService } = require('./snapshot');

const { NullSigningService }      = require('../adapters/NullSigningService');
const { NullDomainAdapter }       = require('../adapters/NullDomainAdapter');
const { KBStoreEntryRepository }  = require('../adapters/KBStoreEntryRepository');
const { HybridSearchEngine }      = require('../adapters/HybridSearchEngine');

function buildLocalRegistry({ dataDir } = {}) {
  if (!dataDir) throw new Error('buildLocalRegistry: dataDir is required');

  const store = new KBStore({ dataDir });

  // Stateless / process-scoped services
  const signing = new NullSigningService();
  const domain  = new NullDomainAdapter();
  const graph    = new GraphEngine(store.db);
  const gaps     = new GapsEngine({ db: store.db });
  const snapshot = new SnapshotService({ store });
  const search  = new HybridSearchEngine({
    db: store.db,
    semanticSearch: store.semanticSearch,
    // cache: defaults to a fresh CandidateCache inside HybridSearchEngine
  });

  // Repository is per-project — KBStoreEntryRepository binds projectId at
  // construction (Recall convention). Cache by projectId so repeated .get()
  // returns the same instance.
  const repoCache = new Map();
  function getRepository(projectId) {
    if (!projectId) {
      throw new Error(
        'registry.get("repository", projectId) — projectId is required for local-mode (multi-project KBs)'
      );
    }
    if (!repoCache.has(projectId)) {
      repoCache.set(projectId, new KBStoreEntryRepository(store, projectId));
    }
    return repoCache.get(projectId);
  }

  return {
    get(key, ...args) {
      switch (key) {
        case 'signing':    return signing;
        case 'store':      return store;
        case 'repository': return getRepository(args[0]);
        case 'search':     return search;
        case 'graph':      return graph;
        case 'gaps':       return gaps;
        case 'snapshot':   return snapshot;
        case 'domain':     return domain;
        default:
          throw new Error(`Unknown registry key: "${key}"`);
      }
    },

    close() {
      if (store && typeof store.close === 'function') store.close();
    },
  };
}

module.exports = { buildLocalRegistry };
