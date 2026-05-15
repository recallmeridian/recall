'use strict';

// Consolidation — Slice 1a: LLM-as-judge for borderline duplicate clusters.
//
// The detector (Slice 0) finds candidate clusters from string similarity.
// This module asks the configured LLM "are these actually duplicates? if
// yes, propose a canonical synthesis." Returns a structured judgement
// suitable for building a MergeProposal in Slice 1b.
//
// Pure given an ILLMProvider; tests pass a stub.
//
// Output shape (a "ClusterJudgement"):
//   {
//     isDuplicate: bool,
//     confidence: 0..1,
//     synthesis: { name, description } | null,
//     rationale: string,
//     perEntryNotes: [{ id, role: 'canonical'|'redundant'|'partial', note: string }],
//     model: string,
//     judgedAt: ISO timestamp,
//     parseFailed: bool
//   }

function buildSystemPrompt() {
  return [
    'You are a knowledge-base curator deciding whether a cluster of entries is actually about the same thing.',
    'You receive a cluster of N entries (id + name + full description). Your job:',
    '(1) Decide isDuplicate: true if these entries describe the same fact/decision/lesson at a meaningful level, false if they only share keywords.',
    '(2) If isDuplicate=true, propose synthesis: a single canonical { name, description } that captures what all of them are about, citing the source ids.',
    '(3) For each member, label its role: "canonical" (the closest single best statement), "redundant" (covered by canonical, can be retired), or "partial" (covers something canonical misses; should be merged into synthesis description).',
    'Be conservative. If the cluster looks like a coincidence (same domain words, different actual content), set isDuplicate=false and confidence < 0.5. Do not invent overlap.',
    'Return strictly a JSON object: { isDuplicate, confidence, synthesis, rationale, perEntryNotes }. No prose outside the JSON. synthesis may be null if isDuplicate=false.',
  ].join(' ');
}

function buildUserPrompt(cluster, entries) {
  const fullEntries = (entries || []).map((e) => ({
    id: e.id,
    name: e.name,
    description: e.description,
  }));
  return [
    `Cluster: ${cluster.id}`,
    `Category: ${cluster.category || 'unknown'}`,
    `Project:  ${cluster.project || 'unknown'}`,
    `Average pairwise similarity: ${cluster.avgSimilarity}`,
    `Member count: ${fullEntries.length}`,
    '',
    'Member entries (full):',
    JSON.stringify(fullEntries, null, 2),
    '',
    'Return your judgement as a JSON object matching the schema in the system prompt.',
  ].join('\n');
}

function tryParseJson(content) {
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch (_) {
    const match = candidate.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch (_) { return null; }
  }
}

function asString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeJudgement(parsed, modelName) {
  if (!parsed || typeof parsed !== 'object') {
    return {
      isDuplicate: false,
      confidence: 0,
      synthesis: null,
      rationale: '',
      perEntryNotes: [],
      model: modelName || '',
      judgedAt: new Date().toISOString(),
      parseFailed: true,
    };
  }
  const isDuplicate = parsed.isDuplicate === true;
  const confRaw = Number(parsed.confidence);
  const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : 0;
  const rationale = asString(parsed.rationale);
  let synthesis = null;
  if (isDuplicate && parsed.synthesis && typeof parsed.synthesis === 'object') {
    synthesis = {
      name: asString(parsed.synthesis.name),
      description: asString(parsed.synthesis.description),
    };
    if (!synthesis.name || !synthesis.description) synthesis = null;
  }
  const perEntryNotes = Array.isArray(parsed.perEntryNotes)
    ? parsed.perEntryNotes
        .filter((n) => n && typeof n === 'object' && n.id)
        .map((n) => ({
          id: String(n.id),
          role: ['canonical', 'redundant', 'partial'].includes(n.role) ? n.role : 'partial',
          note: asString(n.note),
        }))
    : [];
  return {
    isDuplicate,
    confidence,
    synthesis,
    rationale,
    perEntryNotes,
    model: modelName || '',
    judgedAt: new Date().toISOString(),
    parseFailed: false,
  };
}

/**
 * @param {object} cluster   From clusterDuplicates() — must have id, memberIds, etc.
 * @param {object[]} entries Full entry contents (id + name + description) for cluster members
 * @param {object} llmProvider  ILLMProvider instance
 * @param {object} [opts]
 * @param {number} [opts.temperature]  default 0.1 — judging is conservative work
 */
async function judgeCluster(cluster, entries, llmProvider, opts = {}) {
  if (!cluster || !cluster.id) throw new Error('judgeCluster: cluster is required');
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('judgeCluster: entries must be a non-empty array');
  if (!llmProvider || typeof llmProvider.chat !== 'function') {
    throw new Error('judgeCluster: llmProvider must implement ILLMProvider.chat()');
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserPrompt(cluster, entries) },
  ];
  const response = await llmProvider.chat({
    messages,
    temperature: Number.isFinite(opts.temperature) ? opts.temperature : 0.1,
    json: true,
  });
  const parsed = tryParseJson(response.content);
  return normalizeJudgement(parsed, response.model);
}

module.exports = {
  buildSystemPrompt,
  buildUserPrompt,
  tryParseJson,
  normalizeJudgement,
  judgeCluster,
};
