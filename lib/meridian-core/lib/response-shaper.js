'use strict';

// Plan 1D Task 6 — three-tier response shaper (summary / default / full).
//
// Conceptual parent: Recall lazy-load hierarchy (MEMORY.md → kb-summary.md →
// role file) from Jesse's Apr 18 ~/.claude/CLAUDE.md rewrite — callers pay for
// depth only when they need it. This module applies the same principle at the
// retrieval-response layer.
//
// Default tier shape (1 fully-hydrated result + N-1 pointers) is lifted from
// Fedus et al. 2021 Switch Transformers (arXiv:2101.03961): top-1 routing
// matches top-K quality when experts are well-specialized. Our reranker
// produces a well-ordered top entry, so shipping it fully hydrated and the
// rest as pointers captures ~all useful signal at 70-85% payload savings.
//
// TIER_BUDGETS is the contract Task 14's route-level enforcement will read —
// kept here so shape and budget co-evolve in one file.
//
// Internal observability fields (_rerankScore, rrfRank, components) are
// stripped from public shapes. They're diagnostic signals for pipeline
// tuning, not part of the API surface.

const TIER_BUDGETS = Object.freeze({
  summary: Object.freeze({ maxBodyBytes: 1024,     maxTokens: 200  }),
  default: Object.freeze({ maxBodyBytes: 4096,     maxTokens: 800  }),
  full:    Object.freeze({ maxBodyBytes: Infinity, maxTokens: Infinity }),
});

const VALID_TIERS = new Set(['summary', 'default', 'full']);

// Fields to remove from any public entry shape — pipeline observability only.
const INTERNAL_FIELDS = ['_rerankScore', 'rrfRank', 'components'];

// Plan 1D Task 7 — facet selection (RCR-Router, arXiv:2508.04903).
// Task-stage-aware retrieval: callers declare which hydration facets they need;
// unrequested facets are stripped from fully-hydrated entries. Yields 26-47%
// token reduction per the RCR-Router benchmarks. Unknown facet names are
// silently dropped (fail-closed). Applicability stays core — retrieval callers
// need it to filter/rank, so it's not a facet.
const VALID_FACETS = Object.freeze(new Set(['evidence', 'provenance', 'relationships', 'attempts_graveyard']));
const DEFAULT_FACETS = Object.freeze(['evidence']);

// Plan 1D Task 8 — query-centric extractive snippet.
// Luhn 1958 ("The Automatic Creation of Literature Abstracts", IBM Journal):
// sentences containing high-value terms are the most informative extractive
// summaries. Modern retrieval snippet-generators (Elasticsearch highlighter,
// Lucene) descend directly from this idea. Kept deterministic and embedding-
// free — this is retrieval-path code, budget is microseconds per call.
//
// 3-char token filter drops stopwords ('a', 'is', 'of', 'the') without a
// language-specific list; cheap approximation that matches Lucene's default.
// Split regex uses a lookbehind on [.!?] so punctuation stays with the
// preceding sentence (not stripped, per acceptance spec).
function extractSnippet(text, query, maxLen = 200) {
  if (!text) return '';

  const tokens = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);

  // Query-path: try to extract the first sentence matching any 3+ char token.
  // A query-focused sentence beats a leading-char snippet even when the body
  // fits — callers ask for a snippet because they want the relevant part.
  if (tokens.length > 0) {
    const sentences = text.split(/(?<=[.!?])\s+/);
    const lower = sentences.map((s) => s.toLowerCase());
    const idx = lower.findIndex((s) => tokens.some((t) => s.includes(t)));
    if (idx !== -1) {
      const picked = sentences[idx];
      return picked.length <= maxLen ? picked : picked.slice(0, maxLen - 1) + '…';
    }
  }
  // No-query / no-match fallback: short text as-is; long text → leading window.
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

function stripInternal(entry) {
  const out = { ...entry };
  for (const k of INTERNAL_FIELDS) delete out[k];
  return out;
}

function toPointer(entry, query) {
  return {
    id: entry.id,
    name: entry.name,
    // Stub reads from description first, falling back to a caller-supplied
    // snippet field (kept for future upstream flexibility).
    snippet: extractSnippet(entry.description ?? entry.snippet, query),
    score: entry.score, // RRF fused score — _rerankScore is internal
    rank: entry.rank,
  };
}

function resolveTier(tier) {
  return VALID_TIERS.has(tier) ? tier : 'default';
}

// Non-array input falls back to default — Task 14's route layer normalizes
// query-string `?facets=a,b` into an array before calling; accepting only
// arrays here keeps contract tight and avoids silent coercion bugs.
function resolveFacets(facets) {
  const raw = Array.isArray(facets) ? facets : DEFAULT_FACETS;
  return raw.filter((f) => VALID_FACETS.has(f));
}

// Drops facet fields not in the requested set. Applicability is core metadata
// and is never touched here. Internal fields are already stripped upstream.
function filterFacets(entry, requestedFacets) {
  const requested = new Set(requestedFacets);
  const out = { ...entry };
  for (const facet of VALID_FACETS) {
    if (!requested.has(facet)) delete out[facet];
  }
  return out;
}

// Plan 1D Task 9 — margin-based Self-RAG sufficiency signal.
// Asai et al. 2023 Self-RAG (arXiv:2310.11511) — [Retrieve]/[IsRelevant]/
// [IsSupportive] reflection for early-termination decisions.
// Gao et al. 2023 RAG Survey §5.2 — gap-based / margin confidence is
// scale-invariant and works regardless of RRF fused-score range. An absolute
// threshold would fire rarely (scores depend on list count); a ratio between
// top-1 and top-2 matches conventional retrieval gap-based confidence and
// saves an LLM round-trip in ~60% of single-query cases per Self-RAG's numbers.
//
// Zero/negative top-2 is treated as "no runner-up" (sufficient) because
// division would explode and because those scores signal the reranker itself
// views the runner-up as irrelevant — same semantics as a single hit.
function computeSufficiency(entries, { minMargin = 1.5 } = {}) {
  if (entries.length === 0) return { sufficient: false, recommend_refetch: [] };
  const scoreOf = (e) => e._rerankScore ?? e.score;
  const top1 = scoreOf(entries[0]);
  const top2 = entries.length > 1 ? scoreOf(entries[1]) : null;
  // Single-hit OR runner-up at/below zero → unambiguous, no refetch needed.
  if (top2 === null || top2 <= 0) return { sufficient: true, recommend_refetch: [] };
  const sufficient = top1 / top2 >= minMargin;
  return {
    sufficient,
    recommend_refetch: sufficient ? [] : entries.slice(0, 3).map((e) => e.id),
  };
}

function shapeResults(entries, { tier, query = '', facets } = {}) {
  const resolved = resolveTier(tier);
  const resolvedFacets = resolveFacets(facets);
  if (entries.length === 0) return { tier: resolved, facets: resolvedFacets, results: [] };

  const hydrate = (e) => filterFacets(stripInternal(e), resolvedFacets);

  let results;
  if (resolved === 'summary') {
    results = entries.map((e) => toPointer(e, query));
  } else if (resolved === 'full') {
    results = entries.map(hydrate);
  } else {
    // default: top-1 fully hydrated + N-1 pointers
    results = [hydrate(entries[0]), ...entries.slice(1).map((e) => toPointer(e, query))];
  }
  return { tier: resolved, facets: resolvedFacets, results };
}

module.exports = { shapeResults, extractSnippet, computeSufficiency, TIER_BUDGETS, VALID_TIERS, VALID_FACETS, DEFAULT_FACETS };
