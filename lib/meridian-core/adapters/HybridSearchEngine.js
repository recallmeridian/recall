'use strict';
// HybridSearchEngine — ISearchEngine adapter wrapping the Plan 1D retrieval pipeline.
//
// Pipeline: Robertson & Zaragoza 2009 (BM25 via FTS5) + Reimers & Gurevych 2019
// (dense, OpenAI text-embedding-3-small) + Cormack 2009 (RRF k=60) + Asai 2023
// (Self-RAG sufficiency signal). See v1-search.js for per-step citations.
//
// Strangler Fig (Fowler 2004): v1-search.js delegates here in Task 4;
// until then this adapter is available but unused by routes.
const { ISearchEngine } = require('../ports/ISearchEngine');
const { BM25Index } = require('../lib/bm25-index');
const { rrfMerge } = require('../lib/rrf-merger');
const { rerank } = require('../lib/reranker');
const { shapeResults, computeSufficiency } = require('../lib/response-shaper');
const { CandidateCache } = require('../lib/candidate-cache');
const { buildPrefilterSQL } = require('../lib/prefilter');

const TIER_DEFAULT_LIMITS = Object.freeze({ summary: 3, default: 10, full: 50 });
const MAX_LIMIT = 50;
// CANDIDATE_LIMIT is the top-K we pull from each retriever into RRF. 50 keeps
// fusion expressive enough for any tier (full allows up to 50 results) without
// overloading the in-process rerank loop.
const CANDIDATE_LIMIT = 50;
const VALID_TIER_SET = new Set(['summary', 'default', 'full']);

// parseJSONField is legitimate boundary validation — v3.2 JSON columns are
// TEXT in SQLite and authors can upstream malformed JSON. The try/catch here
// and denseRank's catch below are the ONLY allowed catches in this module.
function parseJSONField(v) {
  if (v === null || v === undefined || typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

// Plan 2A will populate this from a trust config; stub for Plan 1D.
function getTrustedSources() {
  return new Set();
}

function resolveTier(tier) {
  return VALID_TIER_SET.has(tier) ? tier : 'default';
}

function effectiveLimit(limit, tier) {
  const base = (typeof limit === 'number' && limit > 0)
    ? limit
    : TIER_DEFAULT_LIMITS[tier];
  return Math.min(base, MAX_LIMIT);
}

// Runs the structured pre-filter and returns a Set<id> (or null if no filter).
// Caller intersects RRF output against this set — narrows the candidate
// universe without coupling the retrievers to the prefilter schema.
function runPrefilter(db, filter) {
  const { where, params } = buildPrefilterSQL(filter || {});
  if (!where) return null;
  const rows = db
    .prepare(`SELECT id FROM entries WHERE (${where}) AND status='active'`)
    .all(...params);
  return new Set(rows.map((r) => r.id));
}

// Hydrate the fused rank list with full entry rows + hub-local usage LEFT JOIN,
// merge observability fields on top, and parse v3.2 JSON columns.
//
// The LEFT JOIN projects entry_usage.{lastUsedAt, lastShownAt, responseStrength}
// onto `last_used_at`, `last_shown_at`, `response_strength` so the reranker
// (and any future usage-aware stage) sees flat columns. Entries with no
// entry_usage row yield NULL → reranker treats as neutral (1.0 multiplier).
// Per Q2 design override, usage lives in a separate hub-local table; this
// JOIN is the only place it touches the retrieval pipeline.
function hydrate(db, fused) {
  if (fused.length === 0) return [];
  const ids = fused.map((e) => e.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`
      SELECT
        e.*,
        u.lastUsedAt       AS last_used_at,
        u.lastShownAt      AS last_shown_at,
        u.responseStrength AS response_strength
      FROM entries e
      LEFT JOIN entry_usage u ON u.projectId = e.projectId AND u.id = e.id
      WHERE e.id IN (${placeholders}) AND e.status='active'
    `)
    .all(...ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return fused
    .filter((e) => byId.has(e.id))
    .map((e) => {
      const row = byId.get(e.id);
      return {
        ...row,
        evidence: parseJSONField(row.evidence),
        applicability: parseJSONField(row.applicability),
        relationships: parseJSONField(row.relationships),
        provenance: parseJSONField(row.provenance),
        attempts_graveyard: parseJSONField(row.attempts_graveyard),
        // RRF overrides come last so fused score/rank/components win.
        score: e.score,
        rank: e.rank,
        components: e.components,
      };
    });
}

async function retrieveCandidates({ bm25, semanticSearch, q, category, project }) {
  const bm25List = bm25.search(q, { limit: CANDIDATE_LIMIT, category });
  let denseList = [];
  // Graceful degradation — dense retrieval is optional. If the API is down,
  // the env var is missing, or embeddings aren't indexed, we return BM25-only.
  try {
    denseList = await semanticSearch.denseRank(q, { limit: CANDIDATE_LIMIT, project });
  } catch (_) {
    denseList = [];
  }
  return { bm25List, denseList };
}

class HybridSearchEngine extends ISearchEngine {
  /**
   * @param {{ db: import('better-sqlite3').Database, semanticSearch: import('../lib/semantic-search').SemanticSearch, cache: CandidateCache }} opts
   */
  constructor({ db, semanticSearch, cache }) {
    super();
    this.db = db;
    this.semanticSearch = semanticSearch;
    this.cache = cache || new CandidateCache();
    this.bm25 = new BM25Index(db);
  }

  /**
   * Run the hybrid BM25+dense search pipeline.
   * @param {string} query
   * @param {{ q?: string, tier?: string, facets?: string, limit?: number,
   *           category?: string, filter?: object, project?: string }} [opts]
   * @returns {Promise<{ results: object[], sufficient: boolean,
   *                     recommend_refetch: string[], meta: object }>}
   */
  async search(query, opts = {}) {
    const { tier, facets, limit, category, filter, project } = opts;
    const q = query;
    const resolvedTier = resolveTier(tier);

    // Cache key covers only inputs that change the CANDIDATE SET — tier, facets,
    // and limit are pure response-shaping concerns applied per-request over the
    // same cached candidates, so omitting them lets a single retrieval serve
    // every tier/facet/limit variant of the same query.
    const cacheKey = CandidateCache.key({ q, category, filter, project });
    const cached = this.cache.get(cacheKey);

    let candidates;
    let bm25Hits;
    let denseHits;

    if (cached) {
      candidates = cached.candidates;
      bm25Hits = cached.bm25Hits;
      denseHits = cached.denseHits;
    } else {
      const prefilterIds = runPrefilter(this.db, filter);
      const { bm25List, denseList } = await retrieveCandidates({
        bm25: this.bm25, semanticSearch: this.semanticSearch, q, category, project,
      });
      const fused = rrfMerge([bm25List, denseList]);
      const filtered = prefilterIds ? fused.filter((e) => prefilterIds.has(e.id)) : fused;
      const hydrated = hydrate(this.db, filtered);
      candidates = rerank(hydrated, { trustedSources: getTrustedSources() });
      bm25Hits = bm25List.length;
      denseHits = denseList.length;
      this.cache.set(cacheKey, { candidates, bm25Hits, denseHits });
    }

    const limitN = effectiveLimit(limit, resolvedTier);
    const truncated = candidates.slice(0, limitN);
    const shaped = shapeResults(truncated, { tier: resolvedTier, query: q, facets });
    // Sufficiency is a RETRIEVAL-confidence signal (should we keep retrieving?),
    // not a display signal. Run it over the full reranked candidate set so that
    // e.g. limit:1 still surfaces a close runner-up and recommends refetch.
    const sufficiency = computeSufficiency(candidates);

    return {
      tier: shaped.tier,
      facets: shaped.facets,
      results: shaped.results,
      sufficient: sufficiency.sufficient,
      recommend_refetch: sufficiency.recommend_refetch,
      meta: {
        bm25_hits: bm25Hits,
        dense_hits: denseHits,
        total_candidates: candidates.length,
        cache_hit: !!cached,
      },
    };
  }
}

module.exports = { HybridSearchEngine, TIER_DEFAULT_LIMITS, MAX_LIMIT, CANDIDATE_LIMIT };
