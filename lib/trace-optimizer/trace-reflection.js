'use strict';

// Trace Optimizer — TraceReflectionPort (Slice 1).
//
// Takes a FailureBasin (from failure-basin-detector) plus sample handoffs
// and asks the configured LLMProvider to identify root cause, contributing
// factors, and recommended next actions. The reflection is a *candidate* —
// it does not promote to durable knowledge yet (that's Slice 4).
//
// Hex placement: this module is the recall-cli-level adapter that wires
// the ILLMProvider engine port into the Trace Optimizer pipeline. The
// reflection function is pure given an ILLMProvider — callers supply the
// provider so tests can pass a stub.
//
// Output shape (a "TraceReflection" object) attaches back onto the basin:
//   basin.reflection = {
//     rootCause: string,
//     contributingFactors: string[],
//     recommendedNextActions: string[],
//     confidence: number (0..1, self-reported),
//     model: string,
//     reflectedAt: ISO timestamp
//   }

function buildSystemPrompt() {
  return [
    'You are a Trace Optimizer reflecting on repeated agent failures.',
    'You read a "failure basin" — a cluster of agent sessions that hit the same failure signal — plus a sample of the underlying handoff records.',
    'Your job is to identify (a) the most likely root cause, (b) contributing factors, (c) concrete recommended next actions.',
    'Be specific. Cite handoff IDs when relevant. Prefer fixes that change harness / prompt / tool wiring over fixes that change the model.',
    'Return strictly a JSON object with keys: rootCause (string), contributingFactors (string[]), recommendedNextActions (string[]), confidence (number 0..1). No prose outside the JSON.',
  ].join(' ');
}

function buildUserPrompt(basin, sampleHandoffs) {
  const summary = {
    pattern: basin.pattern,
    count: basin.count,
    agents: basin.agents,
    taskTypes: basin.taskTypes,
    projects: basin.projects,
    sampleHandoffIds: basin.sampleHandoffIds,
    rawSamples: basin.rawSamples,
  };
  const sampleSlices = (sampleHandoffs || []).map((h) => ({
    id: h.id,
    agentId: h.agentId,
    taskType: h.taskType,
    taskSummary: h.taskSummary,
    selectedBecause: h.selectedBecause,
    failureSignals: h.failureSignals,
    reviewFindings: h.reviewFindings,
    draftLessons: h.draftLessons,
    outcome: h.outcome,
  }));
  return [
    'Failure basin summary:',
    JSON.stringify(summary, null, 2),
    '',
    'Up to 5 sample handoffs from this basin:',
    JSON.stringify(sampleSlices.slice(0, 5), null, 2),
    '',
    'Return your reflection as a JSON object matching the schema in the system prompt.',
  ].join('\n');
}

function tryParseJson(content) {
  if (typeof content !== 'string') return null;
  // Strip fenced code blocks if present.
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch (_) {
    // Try to find the first {...} block.
    const match = candidate.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch (_) { return null; }
  }
}

function normalizeReflection(parsed, modelName) {
  if (!parsed || typeof parsed !== 'object') {
    return {
      rootCause: '',
      contributingFactors: [],
      recommendedNextActions: [],
      confidence: 0,
      model: modelName || '',
      reflectedAt: new Date().toISOString(),
      parseFailed: true,
    };
  }
  const arr = (v) => Array.isArray(v) ? v.filter((x) => x !== undefined && x !== null).map(String) : [];
  const conf = Number(parsed.confidence);
  return {
    rootCause: String(parsed.rootCause || '').trim(),
    contributingFactors: arr(parsed.contributingFactors),
    recommendedNextActions: arr(parsed.recommendedNextActions),
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
    model: modelName || '',
    reflectedAt: new Date().toISOString(),
    parseFailed: false,
  };
}

/**
 * Reflect on a single failure basin using the supplied ILLMProvider.
 *
 * @param {object} basin           A FailureBasin from detectBasins()
 * @param {object[]} sampleHandoffs Up to 5 underlying handoffs (full records)
 * @param {object} llmProvider     ILLMProvider implementation
 * @param {object} [opts]
 * @param {number} [opts.temperature]
 * @returns {Promise<object>} TraceReflection
 */
async function reflectOnBasin(basin, sampleHandoffs, llmProvider, opts = {}) {
  if (!basin || !basin.pattern) throw new Error('reflectOnBasin: basin is required');
  if (!llmProvider || typeof llmProvider.chat !== 'function') {
    throw new Error('reflectOnBasin: llmProvider must implement ILLMProvider.chat()');
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserPrompt(basin, sampleHandoffs) },
  ];
  const response = await llmProvider.chat({
    messages,
    temperature: Number.isFinite(opts.temperature) ? opts.temperature : 0.2,
    json: true,
  });
  const parsed = tryParseJson(response.content);
  return normalizeReflection(parsed, response.model);
}

// ---------------------------------------------------------------------------
// Multi-perspective reflection (Slice 1 IL sprint refinement, 2026-05-13)
//
// The single-perspective reflectOnBasin uses one prompt + one temperature.
// Multi-perspective runs the same basin through N alternative prompt
// "lenses" and merges the candidate reflections. Different lenses bias
// the model toward different root-cause hypothesis spaces (mechanical vs
// alignment vs procedural). Disagreement across lenses surfaces uncertainty
// that the single-shot version hides.
//
// Lenses (default 3):
//   1. "mechanical"   — bias toward concrete code / config / data root causes
//   2. "alignment"    — bias toward prompt / spec / instruction-following
//   3. "procedural"   — bias toward harness / orchestration / wiring
//
// Output: { perspectives: [{ lens, reflection }], merged: TraceReflection,
//           agreement: { rootCauseConsensus: number 0..1, ... } }
// ---------------------------------------------------------------------------

const LENS_PROMPTS = {
  mechanical: 'You are biased toward MECHANICAL root causes — concrete code, config, data, dependency, or schema issues. When in doubt, prefer "a specific line of code is wrong" or "the data shape is off" over higher-level explanations.',
  alignment: 'You are biased toward ALIGNMENT root causes — prompt drift, spec ambiguity, the model misunderstanding what was asked. When in doubt, prefer "the instructions to the model were unclear" over "the harness wiring is broken."',
  procedural: 'You are biased toward PROCEDURAL root causes — harness wiring, missing tool calls, orchestration gaps, retries not happening. When in doubt, prefer "a step in the pipeline failed silently" over "the model got the right answer wrong."',
};

function _validateReflectionSchema(parsed) {
  const errors = [];
  if (!parsed || typeof parsed !== 'object') {
    errors.push('reflection is not an object');
    return { ok: false, errors };
  }
  if (typeof parsed.rootCause !== 'string' || !parsed.rootCause.trim()) {
    errors.push('rootCause must be a non-empty string');
  }
  if (!Array.isArray(parsed.contributingFactors)) {
    errors.push('contributingFactors must be an array');
  }
  if (!Array.isArray(parsed.recommendedNextActions)) {
    errors.push('recommendedNextActions must be an array');
  }
  if (parsed.confidence !== undefined && (typeof parsed.confidence !== 'number' || !Number.isFinite(parsed.confidence))) {
    errors.push('confidence must be a finite number');
  }
  return { ok: errors.length === 0, errors };
}

async function reflectMultiPerspective(basin, sampleHandoffs, llmProvider, opts = {}) {
  if (!basin || !basin.pattern) throw new Error('reflectMultiPerspective: basin is required');
  if (!llmProvider || typeof llmProvider.chat !== 'function') {
    throw new Error('reflectMultiPerspective: llmProvider must implement ILLMProvider.chat()');
  }
  const lenses = Array.isArray(opts.lenses) && opts.lenses.length > 0
    ? opts.lenses
    : ['mechanical', 'alignment', 'procedural'];

  const perspectives = [];
  for (const lens of lenses) {
    const lensSystem = (LENS_PROMPTS[lens] || '') + '\n\n' + buildSystemPrompt();
    const messages = [
      { role: 'system', content: lensSystem },
      { role: 'user', content: buildUserPrompt(basin, sampleHandoffs) },
    ];
    let perspectiveResult;
    try {
      const response = await llmProvider.chat({
        messages,
        temperature: Number.isFinite(opts.temperature) ? opts.temperature : 0.3,
        json: true,
      });
      const parsed = tryParseJson(response.content);
      const validation = _validateReflectionSchema(parsed);
      perspectiveResult = {
        lens,
        reflection: normalizeReflection(parsed, response.model),
        schemaValid: validation.ok,
        schemaErrors: validation.errors,
      };
    } catch (err) {
      perspectiveResult = {
        lens,
        reflection: normalizeReflection(null, ''),
        schemaValid: false,
        schemaErrors: ['lens error: ' + err.message],
      };
    }
    perspectives.push(perspectiveResult);
  }

  // Merge: take rootCauses + contributingFactors + recommendedNextActions
  // across lenses, dedupe by lowercase first-80-chars.
  const seenKey = (s) => String(s || '').toLowerCase().slice(0, 80).replace(/\s+/g, ' ').trim();
  const dedupe = (arr) => {
    const seen = new Set();
    const out = [];
    for (const x of arr) {
      const k = seenKey(x);
      if (k && !seen.has(k)) { seen.add(k); out.push(x); }
    }
    return out;
  };

  const allRootCauses = perspectives.map((p) => p.reflection.rootCause).filter(Boolean);
  const allContrib = perspectives.flatMap((p) => p.reflection.contributingFactors || []);
  const allActions = perspectives.flatMap((p) => p.reflection.recommendedNextActions || []);
  const meanConf = perspectives.length
    ? perspectives.reduce((acc, p) => acc + (p.reflection.confidence || 0), 0) / perspectives.length
    : 0;

  // Agreement signal: count distinct root causes (lower = stronger
  // agreement; higher = lenses disagree).
  const distinctRootCauseKeys = new Set(allRootCauses.map(seenKey));
  const rootCauseConsensus = allRootCauses.length
    ? 1 - ((distinctRootCauseKeys.size - 1) / Math.max(1, perspectives.length - 1))
    : 0;

  const merged = {
    rootCause: allRootCauses[0] || '',
    contributingFactors: dedupe(allContrib),
    recommendedNextActions: dedupe(allActions),
    confidence: Number(meanConf.toFixed(3)),
    model: perspectives.map((p) => p.reflection.model).filter(Boolean).join('+'),
    reflectedAt: new Date().toISOString(),
    parseFailed: perspectives.every((p) => p.reflection.parseFailed),
    multiPerspective: true,
    lenses: lenses,
  };

  return {
    perspectives,
    merged,
    agreement: {
      rootCauseConsensus: Number(rootCauseConsensus.toFixed(3)),
      distinctRootCauses: distinctRootCauseKeys.size,
      perspectiveCount: perspectives.length,
      schemaValidCount: perspectives.filter((p) => p.schemaValid).length,
    },
  };
}

module.exports = {
  buildSystemPrompt,
  buildUserPrompt,
  tryParseJson,
  normalizeReflection,
  reflectOnBasin,
  reflectMultiPerspective,
  LENS_PROMPTS,
};
