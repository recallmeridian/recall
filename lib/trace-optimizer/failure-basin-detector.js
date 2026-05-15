'use strict';

// Trace Optimizer — failure-basin detector (Slice 0).
//
// Reads the hard-case lessons mined by intelligence.agent-hard-cases (which
// extracts one entry per failure signal across failed / blocked / uncertain
// handoffs) and clusters them into FailureBasin objects: groups of >=N hard
// cases that share a normalized failure signal.
//
// A "basin" in geomorphic terms is a low point where things accumulate. Same
// idea here: where do agents keep falling into the same hole? Surface the
// hole so a Trace Optimizer reflection step (Slice 1+) can propose a harness/
// prompt/tool fix and verify it on the next run.
//
// Slice 0 scope: detect basins + emit them. Reflection, recommendation,
// verification, and promotion are downstream slices. This is the read half
// of the AgentTraceIngestPort + FailureBasinDetectorPort pair from the
// Trace Optimizer plan (build-recall-trace-optimizer-early-in-feature-registry).

function normalizeSignal(signal) {
  // Defensive coercion: structured failure-signal objects (e.g.
  // { signal: 'sandbox_eperm', detail: '...' }) used to land here as
  // "[object Object]" after `String(obj)`. Now we recognize the common
  // structured shape and extract a readable text head. Upstream
  // mineHardCases already does the canonical form via
  // toFailureSignalString — this is the belt-and-suspenders.
  let text;
  if (signal === null || signal === undefined) text = '';
  else if (typeof signal === 'string') text = signal;
  else if (typeof signal === 'object') {
    const head = signal.signal || signal.summary || signal.message || signal.code || signal.title || signal.type;
    const tail = signal.detail || signal.description || signal.reason;
    if (head && tail) text = `${head}: ${tail}`;
    else if (head) text = String(head);
    else if (tail) text = String(tail);
    else { try { text = JSON.stringify(signal); } catch (_) { text = ''; } }
  } else {
    text = String(signal);
  }
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[`"']/g, '')
    .trim();
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'basin';
}

// Detect failure basins from the hard-case array produced by mineHardCases.
//
// @param {Array<{handoffId, agentId, taskType, failureSignal, project, draftLesson}>} hardCases
// @param {object} opts
// @param {number} opts.minCount  Minimum cluster size to count as a basin (default 3)
// @param {number} opts.sampleLimit  Cap on sampleHandoffIds per basin (default 10)
// @returns {Array<FailureBasin>}  sorted by count desc, then by lastSeen desc
function detectBasins(hardCases, opts = {}) {
  const minCount = Number.isFinite(opts.minCount) ? opts.minCount : 3;
  const sampleLimit = Number.isFinite(opts.sampleLimit) ? opts.sampleLimit : 10;
  const groups = new Map();

  for (const hardCase of (hardCases || [])) {
    const normalized = normalizeSignal(hardCase.failureSignal);
    if (!normalized) continue;
    if (!groups.has(normalized)) {
      groups.set(normalized, {
        pattern: normalized,
        rawSamples: [],
        sampleHandoffIds: [],
        agents: new Set(),
        taskTypes: new Set(),
        projects: new Set(),
        count: 0,
      });
    }
    const group = groups.get(normalized);
    group.count += 1;
    if (group.rawSamples.length < sampleLimit) {
      group.rawSamples.push(hardCase.failureSignal);
    }
    if (hardCase.handoffId && !group.sampleHandoffIds.includes(hardCase.handoffId) && group.sampleHandoffIds.length < sampleLimit) {
      group.sampleHandoffIds.push(hardCase.handoffId);
    }
    if (hardCase.agentId) group.agents.add(hardCase.agentId);
    if (hardCase.taskType) group.taskTypes.add(hardCase.taskType);
    if (hardCase.project) group.projects.add(hardCase.project);
  }

  const basins = [];
  for (const group of groups.values()) {
    if (group.count < minCount) continue;
    basins.push({
      entryType: 'failure_basin',
      id: `basin-${slugify(group.pattern)}`,
      pattern: group.pattern,
      count: group.count,
      sampleHandoffIds: group.sampleHandoffIds,
      rawSamples: group.rawSamples,
      agents: Array.from(group.agents).sort(),
      taskTypes: Array.from(group.taskTypes).sort(),
      projects: Array.from(group.projects).sort(),
      status: 'detected',
      reflection: null, // populated by Slice 1 (TraceReflectionPort)
      recommendation: null, // populated by Slice 1 (HarnessPatchRecommendationPort)
      verification: null, // populated by Slice 2 (VerificationRunnerPort)
      promotionStatus: 'pending_reflection',
    });
  }

  basins.sort((a, b) => b.count - a.count);
  return basins;
}

module.exports = {
  normalizeSignal,
  slugify,
  detectBasins,
};
