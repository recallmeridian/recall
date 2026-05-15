'use strict';

/**
 * gaps.js — Knowledge-gap detection (sinks, orphans, untestedBeliefs, kinIsolation)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RESEARCH GROUNDING (ported verbatim from Recall, originally verified
 * against Recall research project on 2026-04-17, re-verified 2026-04-25)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * SINKS — Gorzelak, Pickles, Asay, Simard 2015 — "Inter-Plant Communication
 *   via Mycorrhizal Networks" (Annals of Botany Plants, PMC4497361):
 *   carbon flow between trees is gradient-driven, not broadcast.
 *   sink_strength × donor_input. Implication: failed queries cluster
 *   (Huggett 2007 P-MAK — similar queries = same sink).
 *
 *   Severity formula:
 *     severity = ln(1 + occurrences) × (1 / (avg_hits + 1)) × (1 + avg_depth)
 *   where donor_boost = 1 + avg_session_depth (deep-work session sink is
 *   more urgent than casual-session sink).
 *
 * ORPHANS — Huggett 2007 P-MAK: unreachable nodes produce no spreading
 *   activation. Recall excluded decay-exempt entries (research papers often
 *   genuinely unconnected at ingest). Meridian SQL doesn't expose
 *   decay-exempt yet (lives in JSON blob); filter deferred to Phase 0.6.
 *
 * UNTESTED BELIEFS — Simard 2016 (Memory and Learning in Plants):
 *   mycorrhizal networks carry BOTH excitatory (glutamate, "pay attention")
 *   AND inhibitory (glycine, "deprioritize") signals. A strong belief with
 *   zero inhibitory edges is UNTESTED. Lopez de Prado / Harvey:
 *   confirmation bias is the #1 killer in quant work. Taleb: knowledge that
 *   survives falsification is epistemically stronger than knowledge with
 *   only confirms.
 *
 *   Default flagging criteria: confirms_in ≥ 5, contradicts_in = 0,
 *   age_days ≥ 60, status = 'active'.
 *
 *   Score: (confirms_in - 4) × log1p(age_days) / 10
 *
 * KIN ISOLATION — Pickles 2016: entries missing kin tags can't receive
 *   kin-boost at retrieval. Detector surfaces entries lacking `kin:*` tags.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PORT NOTES (Recall → Meridian)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * - Recall reads from ~/.recall/recall.db; this port accepts an injected
 *   better-sqlite3 Database (typically KBStore.db). Composition root
 *   (buildLocalRegistry) wires it up.
 *
 * - Schema mapping:
 *     Recall kb_entries           → Meridian entries
 *     Recall kb_relationships     → Meridian relationships
 *       (source_id, target_id, type) → (fromProject, fromId, toProject, toId, type)
 *     Recall kb_queries           → Meridian queries (NOT YET PRESENT — flag-gated)
 *     Recall kb_feature_flags     → Meridian feature_flags (NOT YET PRESENT — falls
 *                                   open; default behavior is "flag off")
 *
 * - Phase 0.5 scope (per spec, Option A — original scope, no expansion):
 *     query-logger and kin-tagger are NOT yet ported. detectSinks() and
 *     detectKinIsolation() are feature-flag-gated and return
 *     { skipped: true, reason: '<infra missing>' } when their inputs are
 *     absent. Phase 0.6 will harvest the missing infra; until then, the
 *     two detectors are no-ops by design.
 *
 * - decay_exempt SQL column: Recall has it on kb_entries; Meridian does
 *   not (lives in JSON blob as confidence.exempt). Filter is dropped here.
 *   Phase 0.6 may add an indexed mirror column.
 */

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'over',
  'have', 'been', 'also', 'their', 'other', 'more', 'most', 'such', 'only',
  'when', 'what', 'where', 'some', 'which', 'than', 'these', 'those',
  'table', 'name', 'description', 'status', 'active', 'select', 'like',
  'count', 'project',
]);

const EXCITATORY_TYPES = ['confirms', 'qualifies', 'child_of'];
const INHIBITORY_TYPES = ['contradicts', 'supersedes', 'deprecates'];

// Tuning constants (preserved from Recall — research-tuned, do not adjust
// without re-grounding):
const MIN_SEVERITY = 0.5;
const CLUSTER_JACCARD = 0.5;
const MAX_CLUSTER_SIZE = 50;

// ─────────────────────────────────────────────────────────────────────
// Helpers (private; pure functions)
// ─────────────────────────────────────────────────────────────────────
function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Cluster queries into groups of semantically-related variants.
 * Simple agglomerative: each query joins the first existing cluster whose
 * representative has Jaccard ≥ CLUSTER_JACCARD, else starts a new cluster.
 * Adapted from ~/.recall/lib/sink-detector.js (preserved verbatim).
 */
function clusterQueries(queryRows) {
  const clusters = [];
  for (const q of queryRows) {
    const tokenSet = new Set(tokenize(q.query_text));
    if (tokenSet.size === 0) continue;

    let joined = false;
    for (const c of clusters) {
      if (c.queries.length >= MAX_CLUSTER_SIZE) continue;
      if (jaccard(tokenSet, c.tokenSet) >= CLUSTER_JACCARD) {
        c.queries.push({ ...q, _tokens: [...tokenSet] });
        for (const t of tokenSet) c.tokenSet.add(t);
        joined = true;
        break;
      }
    }
    if (!joined) {
      clusters.push({
        tokenSet: new Set(tokenSet),
        queries: [{ ...q, _tokens: [...tokenSet] }],
      });
    }
  }
  return clusters;
}

/**
 * Compute severity for a query cluster (Gorzelak 2015):
 *   severity = ln(1 + occurrences) × (1 / (avg_hits + 1)) × (1 + avg_depth)
 */
function computeSeverity(cluster) {
  const queries = cluster.queries;
  const occ = queries.length;
  const avgHits = queries.reduce((s, q) => s + (q.hit_count || 0), 0) / occ;
  const avgDepth = queries.reduce((s, q) => s + (q.session_depth_score || 0), 0) / occ;

  const frequency = Math.log1p(occ);
  const scarcity = 1 / (avgHits + 1);
  const donor = 1 + avgDepth;

  return {
    severity: Math.round(frequency * scarcity * donor * 1000) / 1000,
    frequency,
    scarcity,
    donor,
    occurrences: occ,
    avg_hits: Math.round(avgHits * 100) / 100,
    avg_depth: Math.round(avgDepth * 100) / 100,
  };
}

function pickRepresentative(cluster) {
  if (cluster.queries.length === 0) return '(empty)';
  const sorted = [...cluster.queries].sort((a, b) => {
    const la = (a.query_text || '').length;
    const lb = (b.query_text || '').length;
    if (la !== lb) return la - lb;
    return (b.timestamp || '').localeCompare(a.timestamp || '');
  });
  return sorted[0].query_text;
}

function classifyEdge(type) {
  if (!type) return null;
  if (EXCITATORY_TYPES.includes(type)) return 'excitatory';
  if (INHIBITORY_TYPES.includes(type)) return 'inhibitory';
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// GapsEngine — public class
// ─────────────────────────────────────────────────────────────────────
class GapsEngine {
  /**
   * @param {object} opts
   * @param {import('better-sqlite3').Database} opts.db - shared SQLite handle
   *   (typically KBStore.db). Required.
   */
  constructor({ db } = {}) {
    if (!db) throw new Error('GapsEngine requires a db');
    this.db = db;
  }

  // ────────────────────────────────────────────────────────────────────
  // Internal: feature-flag check.
  // Falls open if the table or row is missing — flag treated as off.
  // ────────────────────────────────────────────────────────────────────
  _isFlagEnabled(flagName) {
    try {
      const row = this.db
        .prepare('SELECT enabled FROM feature_flags WHERE name = ?')
        .get(flagName);
      return row ? row.enabled === 1 : false;
    } catch {
      return false;
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Internal: does the queries table exist + have rows?
  // Phase 0.5 gating — query-logger.js not yet ported.
  // ────────────────────────────────────────────────────────────────────
  _hasQueryLog() {
    try {
      const row = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='queries'")
        .get();
      return Boolean(row);
    } catch {
      return false;
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // detectSinks — Gorzelak 2015 gradient detection
  //
  // Phase 0.5: gated on (a) feature flag `sink_detection` AND (b) presence
  // of `queries` table. Phase 0.6 ports query-logger.js to populate it.
  // ────────────────────────────────────────────────────────────────────
  detectSinks({ sinceDays = 30, minOccurrences = 2, topN = 20, maxHits = 3 } = {}) {
    if (!this._hasQueryLog()) {
      return {
        skipped: true,
        reason: 'queries table not present (query-logger not yet ported — Phase 0.6)',
        sinks: [],
      };
    }
    if (!this._isFlagEnabled('sink_detection')) {
      return { skipped: true, reason: 'sink_detection feature flag is off', sinks: [] };
    }

    const sinceIso = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();

    const rawQueries = this.db
      .prepare(
        `SELECT query_text, hit_count, top_score, session_depth_score, project, timestamp
         FROM queries
         WHERE timestamp >= ?
           AND hit_count <= ?
         ORDER BY timestamp DESC
         LIMIT 5000`
      )
      .all(sinceIso, maxHits);

    if (rawQueries.length === 0) {
      return { skipped: false, sinks: [], total_queries: 0 };
    }

    const clusters = clusterQueries(rawQueries);

    const sinks = clusters
      .filter((c) => c.queries.length >= minOccurrences)
      .map((c) => {
        const sev = computeSeverity(c);
        const projects = [...new Set(c.queries.map((q) => q.project).filter(Boolean))];
        return {
          representative_query: pickRepresentative(c),
          severity: sev.severity,
          frequency: sev.frequency,
          scarcity: sev.scarcity,
          donor_boost: sev.donor,
          occurrences: sev.occurrences,
          avg_hits: sev.avg_hits,
          avg_depth: sev.avg_depth,
          projects,
          sample_queries: c.queries.slice(0, 5).map((q) => q.query_text),
        };
      })
      .filter((s) => s.severity >= MIN_SEVERITY)
      .sort((a, b) => b.severity - a.severity)
      .slice(0, topN);

    return {
      skipped: false,
      sinks,
      total_queries: rawQueries.length,
      total_clusters: clusters.length,
      window_days: sinceDays,
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // detectOrphans — Huggett 2007 P-MAK
  //
  // Active entries with NO relationships in either direction.
  // (decay_exempt filter dropped vs. Recall — column not in Meridian SQL.
  // Phase 0.6 may add an indexed mirror of confidence.exempt.)
  // ────────────────────────────────────────────────────────────────────
  detectOrphans({ limit = 50 } = {}) {
    const sql = `
      SELECT e.id, e.projectId, e.name, e.category, e.addedAt
      FROM entries e
      WHERE e.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM relationships r
          WHERE (r.fromId = e.id AND r.fromProject = e.projectId)
             OR (r.toId   = e.id AND r.toProject   = e.projectId)
        )
      ORDER BY e.addedAt DESC
      LIMIT ?
    `;
    const orphans = this.db.prepare(sql).all(limit);
    return { orphans, count: orphans.length };
  }

  // ────────────────────────────────────────────────────────────────────
  // findUntestedBeliefs — Simard 2016 dual-signal
  //
  // Entries with many confirms_in but zero inhibitory_in are epistemically
  // weak (Taleb negative empiricism). Score by (confirms - threshold) ×
  // log1p(age_days) / 10 — older + more-confirmed = more dangerous.
  // ────────────────────────────────────────────────────────────────────
  findUntestedBeliefs({
    minConfirms = 5,
    maxContradicts = 0,
    minAgeDays = 60,
    limit = 30,
  } = {}) {
    const sql = `
      SELECT * FROM (
        SELECT
          e.id, e.projectId, e.name, e.category, e.addedAt,
          (SELECT COUNT(*) FROM relationships r
            WHERE r.toId = e.id AND r.toProject = e.projectId AND r.type = 'confirms') AS confirms_in,
          (SELECT COUNT(*) FROM relationships r
            WHERE r.toId = e.id AND r.toProject = e.projectId
              AND r.type IN ('contradicts','supersedes','deprecates')) AS inhibitory_in
        FROM entries e
        WHERE e.status = 'active'
          AND (julianday('now') - julianday(e.addedAt)) >= ?
      )
      WHERE confirms_in >= ? AND inhibitory_in <= ?
      ORDER BY confirms_in DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(minAgeDays, minConfirms, maxContradicts, limit);

    return rows
      .map((r) => ({
        ...r,
        untested_score:
          Math.round(
            (r.confirms_in - (minConfirms - 1)) *
              (Math.log1p(
                Math.max(
                  0,
                  Date.now() / 86400000 - new Date(r.addedAt).getTime() / 86400000
                )
              ) /
                10) *
              1000
          ) / 1000,
      }))
      .sort((a, b) => b.untested_score - a.untested_score);
  }

  // ────────────────────────────────────────────────────────────────────
  // detectKinIsolation — Pickles 2016
  //
  // Phase 0.5: kin-tagger.js not yet ported. Without kin tagging, "every
  // entry is isolated" is a meaningless detection. Returns skipped until
  // Phase 0.6.
  //
  // Heuristic for "has kin tags": tags TEXT column contains 'kin:'. If no
  // entries in the DB have such tags, the detector is no-op'd.
  // ────────────────────────────────────────────────────────────────────
  detectKinIsolation({ limit = 50 } = {}) {
    let hasAnyKin = false;
    try {
      const probe = this.db
        .prepare(
          "SELECT 1 FROM entries WHERE tags IS NOT NULL AND tags LIKE '%kin:%' LIMIT 1"
        )
        .get();
      hasAnyKin = Boolean(probe);
    } catch {
      hasAnyKin = false;
    }

    if (!hasAnyKin) {
      return {
        skipped: true,
        reason: 'no kin: tags present (kin-tagger not yet ported — Phase 0.6)',
        isolated: [],
        count: 0,
      };
    }

    const sql = `
      SELECT id, projectId, name, category, addedAt
      FROM entries
      WHERE status = 'active'
        AND (tags IS NULL OR tags NOT LIKE '%kin:%')
      ORDER BY addedAt DESC
      LIMIT ?
    `;
    const isolated = this.db.prepare(sql).all(limit);
    return { skipped: false, isolated, count: isolated.length };
  }

  // ────────────────────────────────────────────────────────────────────
  // aggregate — single report combining all four signal types
  // ────────────────────────────────────────────────────────────────────
  aggregate(opts = {}) {
    return {
      generatedAt: new Date().toISOString(),
      sinks: this.detectSinks(opts.sinks),
      orphans: this.detectOrphans(opts.orphans),
      untestedBeliefs: this.findUntestedBeliefs(opts.untestedBeliefs),
      kinIsolation: this.detectKinIsolation(opts.kinIsolation),
    };
  }
}

module.exports = {
  GapsEngine,
  EXCITATORY_TYPES,
  INHIBITORY_TYPES,
  STOPWORDS,
  classifyEdge,
  // Internal helpers exposed for testing only:
  _internal: { tokenize, jaccard, clusterQueries, computeSeverity, pickRepresentative },
};
