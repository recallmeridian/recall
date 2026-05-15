'use strict';

// Plan 1D Task 5 — content-intrinsic post-RRF reranker.
//
// Multiplicative blend of three signals — Meridian's content-intrinsic-signals
// doctrine: ranking quality should fall back gracefully on data we already
// curate (confidence, verification timestamp, source trust) before reaching
// for a neural cross-encoder (deferred to Plan 2A). Multiplication (not
// weighted sum) is intentional — a near-zero trust signal must dominate so a
// stale or low-confidence entry can't ride a strong RRF score to the top.
//
// Freshness uses exponential decay exp(-Δt/τ), the standard time-series
// half-life form (Hawkes / EWMA convention). decay_days is the τ (mean life,
// not half-life) — at Δt=τ the weight is 1/e ≈ 0.368.
//
// Confidence floor of 0.1 (not 0): a missing-but-not-disproven signal
// shouldn't annihilate the entry — the user can still surface it via strong
// RRF + freshness. Cap at 1.0 to neutralize accidental over-1 inputs.
//
// KIN_BOOST=1.5 picked to roughly offset one decay half-life (exp(-0.7) ≈ 0.5)
// — kin sources stay competitive with fresher non-kin sources without
// overwhelming the lexical/semantic signal entirely.

const DEFAULT_DECAY_DAYS = 180;
const KIN_BOOST = 1.5;
const MS_PER_DAY = 86_400_000;

// ─────────────────────────────────────────────────────────────────────
// Phase 0.5 harvest — usage telemetry factors.
//
// RESEARCH GROUNDING (verified against Recall research project, 2026-04-23)
//
//   schmid-2014-habituation-mechanisms (Schmid, Wilson, Rankin 2014):
//     "habituation uses different neural mechanisms at different timescales
//     — seconds (synaptic depression), minutes (presynaptic vesicle
//     depletion), hours (receptor trafficking), days (protein synthesis,
//     structural changes). Short-term and long-term habituation are
//     separable pathways."
//
//     → lastShownAt (short-term, fast decay) and lastUsedAt (long-term,
//       slow decay) are SEPARATE pathways. This module touches lastUsedAt
//       only — it is the long-term "is this entry actually useful" signal.
//       lastShownAt belongs to the gap detector ("shown but never used =
//       retrieval-quality failure", not entry-quality failure).
//
//   habituation-in-non-neural-organisms-evidence-from-slime-moulds-boisseau-
//     vogel-du (Boisseau, Vogel, Dussutour 2016):
//     Habituation is a "filter-out" signal where the more-habituated state
//     dominates. → multiplicative blending (matches existing reranker
//     doctrine — a near-zero signal must dominate).
//
// Constants:
//   LAST_USED_TAU = DEFAULT_DECAY_DAYS = 180 days. Aligned with existing
//     freshness τ; long-term knowledge persistence is one phenomenon with
//     one decay rate. Not an independent tunable.
//
//   responseStrength clamp [0.05, 1.0]:
//     Floor 0.05 (lower than confidence floor 0.1 — usage is noisier).
//     Boisseau: organisms recover from habituation; full annihilation wrong.
//     Missing → 1.0 (neutral), matches clampConfidence convention.
//
// Usage fields on the entry are populated by an upstream LEFT JOIN from
// HybridSearchEngine (entry_usage table → flat columns response_strength,
// last_used_at). Entries with no usage row yield NULL columns → 1.0
// multipliers → no penalty.
// ─────────────────────────────────────────────────────────────────────
const LAST_USED_TAU = DEFAULT_DECAY_DAYS;

function clampConfidence(c) {
  if (c == null) return 1.0; // untracked → no penalty
  if (c < 0.1) return 0.1;
  if (c > 1.0) return 1.0;
  return c;
}

function clampResponseStrength(rs) {
  if (rs == null) return 1.0;   // missing = neutral
  if (rs < 0.05) return 0.05;   // floor — Boisseau recovery
  if (rs > 1.0) return 1.0;
  return rs;
}

function freshness(entry, nowMs) {
  if (entry.decay_exempt) return 1.0;
  if (!entry.last_verified) return 1.0;
  const ageDays = (nowMs - new Date(entry.last_verified).getTime()) / MS_PER_DAY;
  const tau = entry.decay_days ?? DEFAULT_DECAY_DAYS;
  return Math.exp(-ageDays / tau);
}

function usedRecency(entry, nowMs) {
  if (!entry.last_used_at) return 1.0;     // missing = neutral
  const ageDays = (nowMs - new Date(entry.last_used_at).getTime()) / MS_PER_DAY;
  if (ageDays < 0) return 1.0;             // future timestamp = neutral
  return Math.exp(-ageDays / LAST_USED_TAU);
}

function rerank(entries, { trustedSources = new Set(), now = new Date() } = {}) {
  const nowMs = now.getTime();
  const scored = entries.map((entry) => {
    const conf          = clampConfidence(entry.confidence_score);
    const fresh         = freshness(entry, nowMs);
    const kin           = trustedSources.has(entry.source_trust_id) ? KIN_BOOST : 1.0;
    const usageStrength = clampResponseStrength(entry.response_strength);
    const usedFresh     = usedRecency(entry, nowMs);
    // Multiplicative per Boisseau 2016 — filter-out dominance.
    // lastShownAt is NOT in the score (Schmid 2014 — separable pathway).
    return {
      ...entry,
      _rerankScore: entry.score * conf * fresh * kin * usageStrength * usedFresh
    };
  });
  scored.sort((a, b) => b._rerankScore - a._rerankScore);
  return scored.map((e, i) => ({ ...e, rrfRank: e.rank, rank: i + 1 }));
}

module.exports = { rerank, DEFAULT_DECAY_DAYS, KIN_BOOST, LAST_USED_TAU };
