'use strict';

// Trace Optimizer — HarnessPatchRecommendationPort (Slice 2).
//
// Takes a FailureBasin + its TraceReflection (Slice 1 output) and asks the
// configured LLMProvider to recommend a CONCRETE patch that would prevent
// the basin from recurring. The patch is a *candidate* — Slice 3
// (VerificationRunnerPort) is what actually applies it and verifies the
// result before Slice 4 promotes anything to durable terrain.
//
// The recommendation is intentionally biased toward harness / prompt / tool
// fixes over model swaps or feature rewrites. The cheapest fix that closes
// the failure mode wins.
//
// Hex placement: recall-cli-level adapter that wires the ILLMProvider
// engine port into the Trace Optimizer pipeline. Pure given an
// ILLMProvider — callers supply the provider so tests can pass a stub.
//
// Output shape (a "HarnessPatchRecommendation") attaches back onto the basin:
//   basin.recommendation = {
//     patchKind: 'prompt_edit' | 'doc_edit' | 'code_edit' | 'config_edit' | 'guard_add' | 'test_add' | 'other',
//     target: { file: string, section: string|null, locator: string|null },
//     change: { before: string, after: string, diffSummary: string },
//     rationale: string,
//     estimatedImpact: 'high' | 'medium' | 'low',
//     riskNotes: string[],
//     confidence: number (0..1),
//     model: string,
//     recommendedAt: ISO timestamp,
//     parseFailed: boolean
//   }

const VALID_PATCH_KINDS = new Set([
  'prompt_edit', 'doc_edit', 'code_edit', 'config_edit', 'guard_add', 'test_add', 'other',
]);
const VALID_IMPACTS = new Set(['high', 'medium', 'low']);

function buildSystemPrompt() {
  return [
    'You are a Trace Optimizer recommending a concrete patch to fix a recurring agent failure.',
    'You are given a "failure basin" (a cluster of agent sessions hitting the same failure signal) and a prior reflection (root cause + contributing factors + recommended next actions).',
    'Your job is to propose ONE specific, actionable patch — not multiple alternatives — that would prevent the pattern from recurring.',
    'Strongly prefer fixes that change harness configuration, prompt content, agent instructions, or tool wiring over fixes that change models or rewrite features wholesale. The cheapest fix that closes the failure mode wins.',
    'Be concrete: name a file path, a section header, or a specific behavior. Describe the change as a before/after pair. If your evidence is too weak to recommend a concrete patch, say so explicitly (patchKind="other", confidence<0.3, diffSummary="no actionable patch from current evidence"). Do NOT invent file paths or sections you have no evidence for.',
    'Return strictly a JSON object with: patchKind (one of: prompt_edit, doc_edit, code_edit, config_edit, guard_add, test_add, other), target { file, section, locator }, change { before, after, diffSummary }, rationale, estimatedImpact (high|medium|low), riskNotes (array of strings), confidence (0..1). No prose outside the JSON.',
  ].join(' ');
}

function buildUserPrompt(basin, reflection) {
  const basinSummary = {
    id: basin.id,
    pattern: basin.pattern,
    count: basin.count,
    agents: basin.agents,
    taskTypes: basin.taskTypes,
    projects: basin.projects,
    sampleHandoffIds: basin.sampleHandoffIds,
    rawSamples: basin.rawSamples,
  };
  const reflectionSummary = reflection ? {
    rootCause: reflection.rootCause,
    contributingFactors: reflection.contributingFactors,
    recommendedNextActions: reflection.recommendedNextActions,
    confidence: reflection.confidence,
  } : null;
  return [
    'Failure basin:',
    JSON.stringify(basinSummary, null, 2),
    '',
    'Reflection (Slice 1 output):',
    JSON.stringify(reflectionSummary, null, 2),
    '',
    'Return your patch recommendation as a JSON object matching the schema in the system prompt.',
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

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((x) => x !== undefined && x !== null).map(String);
}

function normalizePatch(parsed, modelName) {
  if (!parsed || typeof parsed !== 'object') {
    return {
      patchKind: 'other',
      target: { file: '', section: null, locator: null },
      change: { before: '', after: '', diffSummary: '' },
      rationale: '',
      estimatedImpact: 'low',
      riskNotes: [],
      confidence: 0,
      model: modelName || '',
      recommendedAt: new Date().toISOString(),
      parseFailed: true,
    };
  }
  const patchKind = VALID_PATCH_KINDS.has(parsed.patchKind) ? parsed.patchKind : 'other';
  const impactRaw = String(parsed.estimatedImpact || '').toLowerCase();
  const estimatedImpact = VALID_IMPACTS.has(impactRaw) ? impactRaw : 'low';
  const conf = Number(parsed.confidence);
  const target = parsed.target && typeof parsed.target === 'object' ? parsed.target : {};
  const change = parsed.change && typeof parsed.change === 'object' ? parsed.change : {};
  return {
    patchKind,
    target: {
      file: String(target.file || '').trim(),
      section: target.section ? String(target.section).trim() : null,
      locator: target.locator ? String(target.locator).trim() : null,
    },
    change: {
      before: String(change.before || '').trim(),
      after: String(change.after || '').trim(),
      diffSummary: String(change.diffSummary || '').trim(),
    },
    rationale: String(parsed.rationale || '').trim(),
    estimatedImpact,
    riskNotes: asStringArray(parsed.riskNotes),
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
    model: modelName || '',
    recommendedAt: new Date().toISOString(),
    parseFailed: false,
  };
}

/**
 * Recommend a concrete patch for a basin given its reflection.
 *
 * @param {object} basin            FailureBasin from detectBasins()
 * @param {object} reflection       TraceReflection from reflectOnBasin()
 * @param {object} llmProvider      ILLMProvider implementation
 * @param {object} [opts]
 * @param {number} [opts.temperature]
 * @returns {Promise<object>} HarnessPatchRecommendation
 */
async function recommendPatch(basin, reflection, llmProvider, opts = {}) {
  if (!basin || !basin.pattern) throw new Error('recommendPatch: basin is required');
  if (!llmProvider || typeof llmProvider.chat !== 'function') {
    throw new Error('recommendPatch: llmProvider must implement ILLMProvider.chat()');
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserPrompt(basin, reflection) },
  ];
  const response = await llmProvider.chat({
    messages,
    temperature: Number.isFinite(opts.temperature) ? opts.temperature : 0.2,
    json: true,
  });
  const parsed = tryParseJson(response.content);
  return normalizePatch(parsed, response.model);
}

module.exports = {
  VALID_PATCH_KINDS,
  VALID_IMPACTS,
  buildSystemPrompt,
  buildUserPrompt,
  tryParseJson,
  normalizePatch,
  recommendPatch,
};
