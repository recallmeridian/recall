'use strict';

const crypto = require('crypto');

const GROUNDING_REFS = [
  'reflexion-2023-verbal-rl',
  'expel-2024-experiential-learners',
  'memento-2025-memory-consolidation',
  'agarwal-2025-persuasion-overrides-truth',
];

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value) {
  return String(value || '').trim();
}

function normalizeKey(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function classifyFailure(trace = {}) {
  const text = [
    trace.failureMode,
    trace.error,
    trace.stderr,
    trace.actualOutcome,
    trace.summary,
    trace.lesson,
  ].map(clean).join(' ').toLowerCase();

  if (/persuad|debate|judge|consensus/.test(text)) return 'debate_persuasion_risk';
  if (/timeout|hung|infinite/.test(text)) return 'execution_timeout';
  if (/missing.*evidence|ungrounded|source/.test(text)) return 'missing_evidence';
  if (/promotion|verified|validated|gate/.test(text)) return 'promotion_gate_bypass';
  if (/test|jest|assert|expect|regression/.test(text)) return 'test_regression';
  return normalizeKey(trace.failureMode || trace.error || 'unknown_failure') || 'unknown_failure';
}

function extractAntiPattern(trace = {}) {
  const failureType = classifyFailure(trace);
  const trigger = clean(trace.trigger || trace.command || trace.prompt || trace.task || '');
  const symptoms = asArray(trace.symptoms).concat(
    clean(trace.error || trace.stderr || trace.actualOutcome || trace.summary || '')
  ).map(clean).filter(Boolean);
  const repair = clean(trace.repair || trace.repairStrategy || trace.nextAction || trace.lesson || '');
  const evidenceRefs = asArray(trace.evidenceRefs || trace.sourceTraceIds || trace.refs).map(clean).filter(Boolean);
  const issues = [];

  if (!failureType || failureType === 'unknown_failure') issues.push('missing_failure_type');
  if (!trigger) issues.push('missing_failure_trigger');
  if (symptoms.length === 0) issues.push('missing_failure_symptoms');
  if (!repair) issues.push('missing_repair_strategy');
  if (evidenceRefs.length === 0) issues.push('missing_evidence_ref');

  const idSeed = `${failureType}|${normalizeKey(trigger)}|${normalizeKey(repair)}`;
  return {
    entryType: 'anti_pattern',
    id: `anti-pattern-${sha256(idSeed).slice(0, 12)}`,
    failureType,
    trigger,
    symptoms,
    repairStrategy: repair,
    evidenceRefs,
    recurrenceCount: 1,
    status: issues.length === 0 ? 'draft' : 'blocked_pending_evidence',
    issues,
    promotionDecision: issues.length === 0 ? 'candidate_lesson' : 'blocked_pending_evidence',
    groundingRefs: GROUNDING_REFS,
  };
}

function mergeAntiPatterns(patterns = []) {
  const byId = new Map();
  asArray(patterns).forEach((pattern) => {
    if (!pattern || !pattern.id) return;
    const existing = byId.get(pattern.id);
    if (!existing) {
      byId.set(pattern.id, {
        ...pattern,
        symptoms: [...asArray(pattern.symptoms)],
        evidenceRefs: [...asArray(pattern.evidenceRefs)],
        recurrenceCount: Number(pattern.recurrenceCount || 1),
      });
      return;
    }
    existing.symptoms = Array.from(new Set(existing.symptoms.concat(asArray(pattern.symptoms))));
    existing.evidenceRefs = Array.from(new Set(existing.evidenceRefs.concat(asArray(pattern.evidenceRefs))));
    existing.recurrenceCount += Number(pattern.recurrenceCount || 1);
    existing.issues = Array.from(new Set(asArray(existing.issues).concat(asArray(pattern.issues))));
    existing.status = existing.issues.length === 0 ? 'draft' : 'blocked_pending_evidence';
  });
  return Array.from(byId.values()).sort((left, right) => {
    return right.recurrenceCount - left.recurrenceCount || left.id.localeCompare(right.id);
  });
}

function mineFailureTraces(input = {}) {
  const traces = asArray(input.traces);
  const patterns = mergeAntiPatterns(traces.map(extractAntiPattern));
  return {
    entryType: 'failure_mining_run',
    traceCount: traces.length,
    antiPatternCount: patterns.length,
    antiPatterns: patterns,
    groundingRefs: GROUNDING_REFS,
  };
}

module.exports = {
  GROUNDING_REFS,
  extractAntiPattern,
  mergeAntiPatterns,
  mineFailureTraces,
};
