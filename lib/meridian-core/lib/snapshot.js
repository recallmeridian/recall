'use strict';

/**
 * SnapshotService — generates pre-ranked context bundles per project.
 *
 * Use case: pre-bake a markdown file consumers (Claude Code, RAG pipelines)
 * read at session start. Replaces per-session KB cold-starts with a single
 * cached context snapshot. Token savings: ~6,500 per Claude Code session
 * vs reading raw entries (one-time generation cost ~1,000 tokens, paid back
 * on the second session).
 *
 * Ranking: composite score using the same multiplicative blend as the
 * reranker (confidence × freshness × usage_strength × usage_recency), MINUS
 * the query-driven RRF score. Snapshot is query-less by design — surfaces
 * "highest-quality entries in this project right now", not "best matches
 * for query X".
 *
 * Pure domain service. Returns value objects; never writes to disk. Caller
 * decides where to persist. Keeps the engine side-effect-free.
 *
 * Research grounding for the ranking factors (already in @meridian/core
 * 0.2.0 reranker.js):
 *   - schmid-2014-habituation-mechanisms (single τ=180 for long-term)
 *   - habituation-in-non-neural-organisms-evidence-from-slime-moulds-
 *     boisseau-vogel-du (multiplicative dominance, 0.05 floor)
 */

const MS_PER_DAY = 86_400_000;
const DEFAULT_DECAY_DAYS = 180;
const LAST_USED_TAU = DEFAULT_DECAY_DAYS;

function clampConfidence(v) {
  if (v == null) return 1.0;
  if (v < 0.1) return 0.1;
  if (v > 1.0) return 1.0;
  return v;
}

function clampResponseStrength(rs) {
  if (rs == null) return 1.0;
  if (rs < 0.05) return 0.05;
  if (rs > 1.0) return 1.0;
  return rs;
}

function freshness(entry, nowMs) {
  const c = entry.confidence;
  if (!c) return 1.0;
  if (c.exempt) return 1.0;
  if (!c.lastVerified) return 1.0;
  const ageDays = (nowMs - new Date(c.lastVerified).getTime()) / MS_PER_DAY;
  const tau = c.decayDays ?? DEFAULT_DECAY_DAYS;
  return Math.exp(-ageDays / tau);
}

function usedRecency(usage, nowMs) {
  if (!usage || !usage.lastUsedAt) return 1.0;
  const ageDays = (nowMs - new Date(usage.lastUsedAt).getTime()) / MS_PER_DAY;
  if (ageDays < 0) return 1.0;
  return Math.exp(-ageDays / LAST_USED_TAU);
}

class SnapshotService {
  /**
   * @param {object} opts
   * @param {KBStore} opts.store - Required. Provides listEntries + getUsage.
   */
  constructor({ store } = {}) {
    if (!store) throw new Error('SnapshotService requires a store');
    this.store = store;
  }

  /**
   * rankEntries(projectId, opts) — returns active entries sorted by composite
   * score (highest first). Score is multiplicative — confidence × freshness
   * × usage_strength × usage_recency. No query in play, so no BM25/dense.
   *
   * @returns {Array<entry & {_score: number}>}
   */
  rankEntries(projectId, { now = new Date() } = {}) {
    const nowMs = now.getTime();
    const entries = this.store.listEntries(projectId, { status: 'active' });
    return entries
      .map((e) => {
        const conf = clampConfidence(e.confidence?.value);
        const fresh = freshness(e, nowMs);
        const usage = this.store.getUsage(projectId, e.id);
        const rs = clampResponseStrength(usage?.responseStrength);
        const ur = usedRecency(usage, nowMs);
        return { ...e, _score: conf * fresh * rs * ur };
      })
      .sort((a, b) => b._score - a._score);
  }

  /**
   * estimateTokens(text) — rough heuristic, ~4 chars per token. Good enough
   * for budgeting; not exact. Real tokenization is model-specific.
   */
  estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * renderMarkdown(projectId, entries, opts) — formats ranked entries as
   * a markdown bundle suitable for CLAUDE.md inclusion. Groups by category,
   * preserves rank ordering within each category.
   */
  renderMarkdown(projectId, entries, { now = new Date() } = {}) {
    const byCategory = new Map();
    for (const e of entries) {
      const cat = e.category || 'uncategorized';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(e);
    }

    const body = [];
    for (const [cat, ents] of byCategory) {
      body.push(`## ${cat}\n`);
      for (const e of ents) {
        body.push(`### ${e.name}\n`);
        if (e.description) body.push(`${e.description}\n`);
        const meta = [];
        if (e.confidence?.value != null) meta.push(`confidence: ${e.confidence.value.toFixed(2)}`);
        if (e.practicalValue) meta.push(`value: ${e.practicalValue}`);
        if (e.source) meta.push(`source: ${e.source}`);
        if (meta.length) body.push(`*${meta.join(' · ')}*\n`);
        body.push('');
      }
    }

    const bodyText = body.join('\n');
    const tokens = this.estimateTokens(bodyText);
    const header = [
      `# Recall Snapshot — ${projectId}`,
      `Generated: ${now.toISOString().slice(0, 10)} | Entries: ${entries.length} | ~${tokens} tokens`,
      '',
    ].join('\n');

    return header + '\n' + bodyText;
  }

  /**
   * generate(opts) — full pipeline: rank → cap by budget/count → render.
   *
   * @param {object} opts
   * @param {string} opts.projectId    Required.
   * @param {number} [opts.tokenBudget=4000]  Approximate token cap. Default
   *   4000 ≈ 1k word context, fits comfortably in a CLAUDE.md preamble.
   * @param {number} [opts.maxEntries] Hard cap on entry count. Wins over
   *   tokenBudget when both are set.
   * @param {Date}   [opts.now]        Override for testing.
   * @returns {{markdown: string, metadata: {projectId, entryCount, tokenEstimate, generatedAt}}}
   */
  generate({ projectId, tokenBudget = 4000, maxEntries, now = new Date() } = {}) {
    if (!projectId) throw new Error('SnapshotService.generate: projectId is required');

    const ranked = this.rankEntries(projectId, { now });

    const selected = [];
    let runningTokens = 0;
    const overheadEstimate = 60;

    for (const entry of ranked) {
      if (maxEntries != null && selected.length >= maxEntries) break;

      const entryTokens =
        this.estimateTokens(entry.name || '') +
        this.estimateTokens(entry.description || '') +
        20;

      if (selected.length > 0 && runningTokens + entryTokens + overheadEstimate > tokenBudget) {
        break;
      }
      selected.push(entry);
      runningTokens += entryTokens;
    }

    const markdown = this.renderMarkdown(projectId, selected, { now });
    return {
      markdown,
      metadata: {
        projectId,
        entryCount: selected.length,
        tokenEstimate: this.estimateTokens(markdown),
        generatedAt: now.toISOString(),
      },
    };
  }
}

module.exports = { SnapshotService };
