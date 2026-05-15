'use strict';

// Plan 1D Task 2 — BM25 retriever over entries_fts (migration 008).
//
// Returns a ranked id list for downstream RRF merging in Task 4 — NOT full
// entries. Score is negated bm25() so higher = better, matching the dense
// retriever's convention so RRF can sort descending uniformly.
//
// Research:
//   - BM25 ranking: Robertson & Zaragoza 2009 (BM25 survey, FnTIR).
//   - FTS5 escape via per-token double-quote: SQLite FTS5 docs §4.4.
//   - Category whitelisting (parameterized + identifier hygiene):
//     OWASP SQLi prevention cheatsheet.

const DEFAULT_LIMIT = 50;

// Per SQLite FTS5 §4.4: a token wrapped in "..." is a literal phrase; any
// embedded " is escaped by doubling. Wrapping every user-input token defangs
// the FTS5 grammar (AND/OR/NOT, parens, *, :, ^, +, -) without losing recall.
function escapeFTS5Query(query) {
  if (typeof query !== 'string') return '';
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}

class BM25Index {
  constructor(db) {
    this.db = db;
  }

  search(query, { limit = DEFAULT_LIMIT, category = null } = {}) {
    const match = escapeFTS5Query(query);
    if (!match) return [];

    // Category filter: parameterized binding only — no string interpolation
    // into SQL even though the route validates upstream (defense-in-depth).
    // Type/length gate keeps obviously-invalid input out of the prepared
    // statement; the corpus is multi-domain so we don't allowlist literals.
    const useCat = typeof category === 'string'
      && category.length > 0
      && category.length <= 64;

    // bm25() returns a negative score where MORE-negative = better-match
    // (FTS5 docs §6). Negate so higher = better for downstream RRF.
    const sql = useCat
      ? `SELECT entries_fts.id AS id, -bm25(entries_fts) AS score
           FROM entries_fts
           JOIN entries ON entries.id = entries_fts.id
          WHERE entries_fts MATCH ?
            AND entries.category = ?
          ORDER BY score DESC
          LIMIT ?`
      : `SELECT id, -bm25(entries_fts) AS score
           FROM entries_fts
          WHERE entries_fts MATCH ?
          ORDER BY score DESC
          LIMIT ?`;

    const params = useCat ? [match, category, limit] : [match, limit];
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((r, i) => ({ id: r.id, score: r.score, rank: i + 1 }));
  }
}

module.exports = { BM25Index, escapeFTS5Query };
