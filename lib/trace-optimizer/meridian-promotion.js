'use strict';

// Trace Optimizer — MeridianPromotionPort (Slice 4).
//
// Final slice of the Trace Optimizer pipeline. Takes a basin that has been
// (1) detected, (2) reflected on, (3) recommended a patch, and (4) verified
// that the patch applies cleanly to a temp copy — and promotes the
// validated pattern to a durable KB lesson.
//
// The typed promotion gate enforces (decision-1777317024151 doctrine):
//   G-X (Executability)        ← verification.status === 'applied'
//   G-T (Truth integrity)       ← verification.syntaxValid !== false
//   G-E (Equivalence evidence)  ← recommendation.parseFailed === false
//                                 && recommendation.confidence >= minConfidence
//
// All three gates must pass before this slice writes anything to the KB.
// Without that, "evolves" is just LLM commentary; with it, the system
// promotes only validated patterns to durable terrain.
//
// Hex placement: recall-cli adapter. Pure given inputs. The buildLesson-
// Payload function is testable in isolation; the promoteToKB function
// takes a kb handle so tests can pass a stub.

const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_CATEGORY = 'lessons';

function evaluatePromotionGate(basin, opts = {}) {
  const minConfidence = Number.isFinite(opts.minConfidence) ? opts.minConfidence : DEFAULT_MIN_CONFIDENCE;
  const reasons = [];

  const recommendation = basin && basin.recommendation;
  const verification = basin && basin.verification;

  if (!recommendation) reasons.push('no_recommendation');
  else if (recommendation.parseFailed) reasons.push('recommendation_parse_failed');
  else if (!Number.isFinite(recommendation.confidence) || recommendation.confidence < minConfidence) {
    reasons.push(`recommendation_confidence_below_${minConfidence}`);
  }

  if (!verification) reasons.push('no_verification');
  else {
    if (verification.status !== 'applied') reasons.push(`verification_status_${verification.status || 'missing'}`);
    if (verification.syntaxValid === false) reasons.push('syntax_invalid');
  }

  return {
    ok: reasons.length === 0,
    reasons,
    minConfidence,
    checkedAt: new Date().toISOString(),
  };
}

function truncate(str, n) {
  const s = String(str || '');
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function buildLessonPayload(basin, opts = {}) {
  const project = (basin && basin.projects && basin.projects[0]) || opts.project || 'recall-dev';
  const recommendation = basin.recommendation || {};
  const reflection = basin.reflection || {};
  const verification = basin.verification || {};

  const patchKind = recommendation.patchKind || 'unknown';
  const name = `Trace Optimizer: "${truncate(basin.pattern, 80)}" → ${patchKind}`;

  const lines = [];
  lines.push(`Failure pattern: ${basin.pattern}`);
  lines.push(`Occurrences:     ${basin.count} (basin id: ${basin.id})`);
  if (basin.agents && basin.agents.length) lines.push(`Agents:          ${basin.agents.join(', ')}`);
  if (basin.taskTypes && basin.taskTypes.length) lines.push(`Task types:      ${basin.taskTypes.join(', ')}`);
  lines.push('');
  if (reflection.rootCause) lines.push(`Root cause: ${reflection.rootCause}`);
  if (reflection.contributingFactors && reflection.contributingFactors.length) {
    lines.push('Contributing factors:');
    reflection.contributingFactors.forEach((f) => lines.push(`- ${f}`));
  }
  lines.push('');
  lines.push(`Recommended patch (${patchKind}, confidence ${Number(recommendation.confidence || 0).toFixed(2)}):`);
  if (recommendation.target && recommendation.target.file) {
    const sec = recommendation.target.section ? ` [${recommendation.target.section}]` : '';
    lines.push(`  Target: ${recommendation.target.file}${sec}`);
  }
  if (recommendation.change && recommendation.change.diffSummary) {
    lines.push(`  Diff:   ${recommendation.change.diffSummary}`);
  }
  if (recommendation.rationale) lines.push(`  Rationale: ${recommendation.rationale}`);
  if (recommendation.riskNotes && recommendation.riskNotes.length) {
    lines.push('  Risks:');
    recommendation.riskNotes.forEach((r) => lines.push(`  - ${r}`));
  }
  lines.push('');
  lines.push(`Verification: status=${verification.status}, applied=${verification.applied}, syntaxValid=${verification.syntaxValid}`);
  if (verification.notes && verification.notes.length) {
    verification.notes.forEach((n) => lines.push(`  - ${n}`));
  }
  if (verification.testsRun) {
    const t = verification.testsRun;
    lines.push(`  Tests: ${t.command} → pass=${t.passCount} fail=${t.failCount} exit=${t.exitCode}`);
  }
  lines.push('');
  lines.push('Promoted by Trace Optimizer Slice 4 (MeridianPromotionPort). Re-verify before applying to live code; this lesson encodes a candidate fix, not an applied one.');

  return {
    project,
    entry: {
      name,
      category: opts.category || DEFAULT_CATEGORY,
      description: lines.join('\n'),
      status: 'active',
      sourceBasinId: basin.id,
      patchKind,
      provenance: {
        author_type: 'trace-optimizer-slice-4-promoted',
        sourceBasinId: basin.id,
        recommendationConfidence: recommendation.confidence || 0,
        verificationStatus: verification.status,
        verificationSyntaxValid: verification.syntaxValid,
        promotedAt: new Date().toISOString(),
      },
    },
  };
}

/**
 * Promote a fully-pipelined basin to a durable KB lesson, but only if it
 * passes the typed promotion gate.
 *
 * @param {object} basin   Basin carrying recommendation + verification
 * @param {object} kb      meridian-core KB handle (must implement addEntry)
 * @param {object} [opts]
 * @param {number} [opts.minConfidence]
 * @param {string} [opts.category]
 * @param {string} [opts.project]
 * @param {boolean} [opts.dryRun] If true, never call kb.addEntry; just return what would happen
 * @returns {{ promoted: boolean, gate, payload, entry?: object, reason?: string }}
 */
function promoteToKB(basin, kb, opts = {}) {
  const gate = evaluatePromotionGate(basin, opts);
  const payload = buildLessonPayload(basin, opts);

  if (!gate.ok) {
    return { promoted: false, gate, payload, reason: `gate_failed: ${gate.reasons.join(', ')}` };
  }

  if (opts.dryRun) {
    return { promoted: false, gate, payload, reason: 'dry_run' };
  }

  if (!kb || typeof kb.addEntry !== 'function') {
    return { promoted: false, gate, payload, reason: 'kb_unavailable' };
  }

  try {
    const entry = kb.addEntry(payload.project, payload.entry);
    return { promoted: true, gate, payload, entry };
  } catch (err) {
    return { promoted: false, gate, payload, reason: `kb_addEntry_failed: ${err.message}` };
  }
}

module.exports = {
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_CATEGORY,
  evaluatePromotionGate,
  buildLessonPayload,
  promoteToKB,
};
