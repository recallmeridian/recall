'use strict';

// Plan 1D Task 4 — Reciprocal Rank Fusion.
//
// Cormack, Clarke, Buttcher 2009, "Reciprocal Rank Fusion outperforms
// Condorcet and individual Rank Learning Methods" (SIGIR'09): for each doc
// d, score(d) = Sum_i 1/(k + rank_i(d)) across rank lists i.
//
// k=60 is not a tuning knob — Cormack et al. swept k on TREC and found 60
// dominates CombSUM/CombMNZ/Condorcet across all tested topic sets. Lower k
// over-weights the very top of each list (fragile to single-ranker bias);
// higher k flattens the curve (loses the rank-position signal RRF exists to
// exploit). Re-evaluate empirically before changing.
//
// Pure function — no DB, no IO. Inputs are the {id, score, rank} lists
// produced by BM25Index.search() (Task 2) and SemanticSearch.denseRank()
// (Task 3); both upstream lists already have rank 1-indexed ascending.

const DEFAULT_K = 60;

/**
 * @param {Array<Array<{id: string, score: number, rank: number}>>} rankLists
 * @param {{k?: number}} [opts]
 * @returns {Array<{id: string, score: number, rank: number,
 *                  components: Object<number, {rank: number, contribution: number}>}>}
 */
function rrfMerge(rankLists, { k = DEFAULT_K } = {}) {
  const fused = new Map();

  rankLists.forEach((list, listIndex) => {
    for (const entry of list) {
      const contribution = 1 / (k + entry.rank);
      const existing = fused.get(entry.id);
      if (existing) {
        existing.score += contribution;
        existing.components[listIndex] = { rank: entry.rank, contribution };
      } else {
        fused.set(entry.id, {
          id: entry.id,
          score: contribution,
          components: { [listIndex]: { rank: entry.rank, contribution } },
        });
      }
    }
  });

  // Tie-break by id ascending so output is deterministic across Node versions
  // and platforms — observability snapshots and golden-master tests need it.
  const sorted = [...fused.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return sorted.map((entry, i) => ({ ...entry, rank: i + 1 }));
}

module.exports = { rrfMerge, DEFAULT_K };
