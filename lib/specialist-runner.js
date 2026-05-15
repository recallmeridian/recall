'use strict';

// Specialist Runner — generic infrastructure for versioned-bundle specialists.
//
// Per Codex's "versioned feature bundle" framing (2026-05-12 critique
// synthesis): a specialist is NOT a model. It's a bundle of manifest +
// prompts + retrieval recipe + output schema + evaluation cases + run
// history. The same model, with the same memory, evolves over time by
// changing the bundle — never the weights.
//
// This module:
//   - validates a bundle's manifest
//   - executes its retrievalRecipe against the KB
//   - assembles the prompt with retrieved context
//   - calls the configured ILLMProvider
//   - parses + validates output
//   - returns a SpecialistRun record (the unit Slice 3-style verification
//     would observe)
//
// The runner is pure given (specialist, input, llmProvider, kb). Tests pass
// stubs for both ports. Real CLI use binds OpenAICompatibleLLM + the
// meridian-core KB handle through the registry.
//
// Specialists themselves live under lib/specialists/<id>.js and export the
// bundle as `module.exports.specialist`. The first one is
// recall-dev-codebase-reviewer.

const REQUIRED_MANIFEST_FIELDS = [
  'id', 'version', 'name', 'description',
  'declaredCapabilities', 'requiredPorts',
  'promptTemplates', 'retrievalRecipe', 'outputSchema',
];

class SpecialistManifestError extends Error {
  constructor(message, fieldErrors) {
    super(message);
    this.name = 'SpecialistManifestError';
    this.fieldErrors = fieldErrors || [];
  }
}

function validateManifest(specialist) {
  const errors = [];
  if (!specialist || typeof specialist !== 'object') {
    throw new SpecialistManifestError('specialist must be an object', ['root']);
  }
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (specialist[field] === undefined || specialist[field] === null) {
      errors.push(`missing required field: ${field}`);
    }
  }
  if (specialist.id && !/^[a-z0-9][a-z0-9-]*$/.test(specialist.id)) {
    errors.push(`id "${specialist.id}" must be lowercase alphanumeric + hyphens`);
  }
  if (specialist.version && !/^\d+\.\d+\.\d+$/.test(specialist.version)) {
    errors.push(`version "${specialist.version}" must be semver (e.g. 0.1.0)`);
  }
  if (specialist.promptTemplates) {
    if (typeof specialist.promptTemplates.system !== 'string') {
      errors.push('promptTemplates.system must be a string');
    }
    if (typeof specialist.promptTemplates.user !== 'function') {
      errors.push('promptTemplates.user must be a function (ctx) => string');
    }
  }
  if (specialist.retrievalRecipe && !Array.isArray(specialist.retrievalRecipe.queries)) {
    errors.push('retrievalRecipe.queries must be an array');
  }
  if (specialist.requiredPorts && !Array.isArray(specialist.requiredPorts)) {
    errors.push('requiredPorts must be an array of port-interface names');
  }
  if (errors.length > 0) {
    throw new SpecialistManifestError(`Manifest invalid (${errors.length} issue${errors.length === 1 ? '' : 's'})`, errors);
  }
  return true;
}

// Execute a retrievalRecipe against a KB handle. Each query in the recipe
// has shape:
//   { category, project, limit, where? }
// The runner uses kb.listEntries() to pull recent matching entries. Future
// versions can layer in semantic match against `input`.
async function executeRetrieval(recipe, kb, opts = {}) {
  if (!recipe || !Array.isArray(recipe.queries)) return [];
  if (!kb || typeof kb.listEntries !== 'function') return [];

  const project = opts.project || recipe.defaultProject || '';
  const results = [];
  for (const q of recipe.queries) {
    try {
      const entries = kb.listEntries(q.project || project, q.category, {
        limit: q.limit || 10,
        ...(q.where || {}),
      }) || [];
      for (const entry of entries) {
        results.push({
          category: q.category,
          project: q.project || project,
          id: entry.id,
          name: entry.name,
          description: entry.description,
          rawEntry: entry,
        });
      }
    } catch (_) {
      // Skip categories the KB doesn't have; don't fail the whole run.
    }
  }
  return results;
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

/**
 * Run a specialist against an input.
 *
 * @param {object} specialist     A loaded specialist bundle
 * @param {string} input          The thing being reviewed (e.g. a code diff, a prompt, a PR description)
 * @param {object} ctx
 * @param {object} ctx.llmProvider  ILLMProvider implementation
 * @param {object} [ctx.kb]         meridian-core KB handle (for retrievalRecipe); optional
 * @param {string} [ctx.project]    Override the recipe's defaultProject
 * @param {object} [opts]
 * @param {number} [opts.temperature]
 * @param {boolean} [opts.json]     Default true — request JSON-mode from provider
 * @returns {Promise<{ specialistId, specialistVersion, input, retrievedContext, output, parseFailed, model, runAt }>}
 */
async function runSpecialist(specialist, input, ctx = {}, opts = {}) {
  validateManifest(specialist);
  if (!ctx.llmProvider || typeof ctx.llmProvider.chat !== 'function') {
    throw new Error('runSpecialist: ctx.llmProvider must implement ILLMProvider.chat()');
  }

  const retrievedContext = await executeRetrieval(specialist.retrievalRecipe, ctx.kb, { project: ctx.project });

  const userMsg = specialist.promptTemplates.user({
    input,
    retrievedContext,
    specialist,
  });

  const messages = [
    { role: 'system', content: specialist.promptTemplates.system },
    { role: 'user', content: userMsg },
  ];

  const response = await ctx.llmProvider.chat({
    messages,
    temperature: Number.isFinite(opts.temperature) ? opts.temperature : 0.2,
    json: opts.json !== false,
  });

  const parsed = tryParseJson(response.content);

  return {
    specialistId: specialist.id,
    specialistVersion: specialist.version,
    input,
    retrievedContextCount: retrievedContext.length,
    retrievedContext: opts.includeRetrievedContext ? retrievedContext : undefined,
    output: parsed,
    parseFailed: parsed === null,
    rawResponseContent: opts.includeRawResponse ? response.content : undefined,
    model: response.model,
    finishReason: response.finishReason,
    runAt: new Date().toISOString(),
  };
}

module.exports = {
  REQUIRED_MANIFEST_FIELDS,
  SpecialistManifestError,
  validateManifest,
  executeRetrieval,
  tryParseJson,
  runSpecialist,
};
