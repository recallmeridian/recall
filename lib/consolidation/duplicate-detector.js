'use strict';

// Consolidation — Slice 0: KB-entry duplicate detector.
//
// Pure, deterministic, no LLM calls. Given a list of KB entries (already
// filtered to a single project/category by the caller), returns clusters
// of likely-duplicates with similarity scores. The downstream consolidation
// step (Slice 1+, not built yet) decides whether to merge, synthesize, or
// retire — this slice only detects.
//
// Algorithm:
//   - tokenize name and description (lowercase, split on non-word chars,
//     drop common stop words and very short tokens)
//   - pairwise Jaccard similarity on token sets
//   - weighted average: name 60%, description 40% (names are the canonical
//     handle; descriptions can drift in wording for the same idea)
//   - build clusters from pairs above threshold via union-find
//
// Choosing pure-string similarity over embeddings here is intentional: it
// avoids the LLM dependency, runs offline, and gives reproducible results.
// Future slices can layer an embedding-based pass on top for the
// borderline cases.

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do',
  'for', 'from', 'has', 'have', 'in', 'into', 'is', 'it', 'its',
  'of', 'on', 'or', 'such', 'that', 'the', 'their', 'then', 'there',
  'these', 'they', 'this', 'to', 'was', 'were', 'will', 'with',
]);

function tokenize(text) {
  if (!text) return new Set();
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')
      .split(/\s+/)
      .filter((tok) => tok.length >= 3 && !STOP_WORDS.has(tok))
  );
}

function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersect = 0;
  for (const item of setA) {
    if (setB.has(item)) intersect += 1;
  }
  const union = setA.size + setB.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function scoreEntryPair(entryA, entryB, opts = {}) {
  const nameWeight = Number.isFinite(opts.nameWeight) ? opts.nameWeight : 0.6;
  const descWeight = 1 - nameWeight;
  const nameSim = jaccard(tokenize(entryA.name), tokenize(entryB.name));
  const descSim = jaccard(tokenize(entryA.description), tokenize(entryB.description));
  return Number((nameWeight * nameSim + descWeight * descSim).toFixed(4));
}

// Union-Find for cluster construction
function makeUF(size) {
  const parent = Array.from({ length: size }, (_, i) => i);
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  return { find, union };
}

// Cluster entries into groups where every pair within the cluster has
// similarity >= threshold to at least one other member (transitive).
// Returns clusters sorted by avgSimilarity desc.
function clusterDuplicates(entries, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : 0.6;
  const maxSummaryLen = Number.isFinite(opts.maxSummaryLen) ? opts.maxSummaryLen : 160;

  const n = (entries || []).length;
  if (n < 2) return { clusters: [], scanned: n, comparisons: 0 };

  const uf = makeUF(n);
  const pairSims = [];
  let comparisons = 0;

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      comparisons += 1;
      const sim = scoreEntryPair(entries[i], entries[j]);
      if (sim >= threshold) {
        uf.union(i, j);
        pairSims.push({ i, j, sim });
      }
    }
  }

  const clusterMap = new Map();
  for (let i = 0; i < n; i += 1) {
    const root = uf.find(i);
    if (!clusterMap.has(root)) clusterMap.set(root, []);
    clusterMap.get(root).push(i);
  }

  const clusters = [];
  for (const [root, indices] of clusterMap.entries()) {
    if (indices.length < 2) continue;
    const sims = pairSims.filter((p) => uf.find(p.i) === root).map((p) => p.sim);
    const avgSimilarity = sims.length === 0 ? 0
      : Number((sims.reduce((a, b) => a + b, 0) / sims.length).toFixed(4));
    clusters.push({
      id: `cluster-${indices[0]}-${indices.length}`,
      memberIds: indices.map((i) => entries[i].id),
      memberSummaries: indices.map((i) => ({
        id: entries[i].id,
        name: String(entries[i].name || '').slice(0, maxSummaryLen),
        descriptionPreview: String(entries[i].description || '').slice(0, maxSummaryLen),
      })),
      avgSimilarity,
      pairCount: sims.length,
    });
  }

  clusters.sort((a, b) => b.avgSimilarity - a.avgSimilarity);

  return {
    clusters,
    scanned: n,
    comparisons,
    threshold,
    clusterCount: clusters.length,
  };
}

module.exports = {
  STOP_WORDS,
  tokenize,
  jaccard,
  scoreEntryPair,
  clusterDuplicates,
};
