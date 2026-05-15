'use strict';

// Synthesis service.
//
// The reviewer's call-out: "compounding memory layer is thin. You have
// negative-promotion, decay, anchors, and reconsolidation collectors,
// but synthesis, strong typed relations, deduplication, and terrain
// morphology as a living signal are still light."
//
// This module is the synthesis piece: given a set of related KB entries
// + an optional reflection (root cause + recommended actions), produce
// a SYNTHESIS entry that:
//   - Cites each source entry by id
//   - Names the type of synthesis (confluence | contradiction | abstraction
//     | extraction | retire-recommendation)
//   - Carries a confidence score (mean of source confidences × consensus)
//   - Is structurally a `decisions` or `lessons` category entry the KB
//     can consume via standard add/relate/promote tooling
//   - Records its provenance in a hash-chained synthesis ledger so
//     "where did this synthesis come from?" is auditable forever
//
// Pattern: this is the kind of memory consolidation the brainstorm's
// "dreaming" idea (Grok + Codex sharpening) called for in §5 — but
// concretely, today, as a callable module the IL cycle / dream cycle
// can invoke when they detect a cluster of related entries.
//
// API:
//   buildSynthesis({ specialistId?, sources: [{id, project, name,
//                    description, confidence?}], reflection?,
//                    synthesisType, name, project, category })
//     → { synthesisEntry, citationRelationships, ledgerEntry }
//
//   appendSynthesisLedger(synthesis, opts)
//   listSyntheses({dataDir, project?})
//   verifySynthesisLedger({dataDir})

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SYNTHESIS_TYPES = Object.freeze({
  CONFLUENCE: 'confluence',           // N entries say the same thing → distill one
  CONTRADICTION: 'contradiction',     // N entries disagree → record the conflict
  ABSTRACTION: 'abstraction',         // N specifics → one general rule
  EXTRACTION: 'extraction',           // 1 long entry → multiple focused entries
  RETIRE_RECOMMENDATION: 'retire-recommendation', // N entries are stale → propose retirement
});

function ledgerPath(opts = {}) {
  return opts.ledgerPath || path.join(opts.dataDir || '', 'security', 'synthesis-ledger.jsonl');
}

function ensureFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', 'utf8');
}

function readLedger(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
}

function _entryHash(entry) {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify({
    sequence: entry.sequence,
    previousHash: entry.previousHash,
    synthesisId: entry.synthesisId,
    synthesisType: entry.synthesisType,
    project: entry.project,
    sourceIds: entry.sourceIds,
    sourceProjects: entry.sourceProjects,
    name: entry.name,
    descriptionHash: entry.descriptionHash,
    confidence: entry.confidence,
    reflectionRef: entry.reflectionRef,
    specialistId: entry.specialistId,
    createdAt: entry.createdAt,
  })).digest('hex');
}

function _mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((acc, v) => acc + v, 0) / arr.length;
}

function _renderConfluenceDescription({ sources, reflection }) {
  const sourceList = sources.map((s) => `  - ${s.id} (${s.project}): ${(s.name || '').slice(0, 60)}`).join('\n');
  const rationale = reflection && reflection.merged && reflection.merged.rootCause
    ? '\n\nReflection root cause:\n' + reflection.merged.rootCause
    : '';
  return `Confluence synthesis: ${sources.length} entries converge on the same point.\n\nSources:\n${sourceList}${rationale}\n\nThis synthesis is itself evidence that the underlying claim holds across multiple independent observations. Promote-eligible if the same claim is needed downstream.`;
}

function _renderContradictionDescription({ sources, reflection }) {
  const sourceList = sources.map((s) => `  - ${s.id} (${s.project}): ${(s.name || '').slice(0, 60)}`).join('\n');
  const note = reflection && reflection.merged && reflection.merged.rootCause
    ? '\n\nReflection on the disagreement:\n' + reflection.merged.rootCause
    : '';
  return `Contradiction synthesis: ${sources.length} entries disagree.\n\nSources in tension:\n${sourceList}${note}\n\nRECOMMENDED ACTION: resolve via human review. Until resolved, downstream queries should treat the underlying claim as DISPUTED, not promoted.`;
}

function _renderAbstractionDescription({ sources, reflection }) {
  const sourceList = sources.map((s) => `  - ${s.id}: ${(s.name || '').slice(0, 60)}`).join('\n');
  const insight = reflection && reflection.merged && reflection.merged.rootCause
    ? '\n\nAbstracted insight:\n' + reflection.merged.rootCause
    : '\n\nAbstracted insight: (none — supply reflection.merged.rootCause to fill in)';
  return `Abstraction synthesis: ${sources.length} specific cases distilled into one general rule.${insight}\n\nSpecific source cases:\n${sourceList}\n\nUse this rule as a higher-level reference; cite the specific source cases for evidence.`;
}

function _renderExtractionDescription({ sources, reflection }) {
  const note = reflection && reflection.merged && reflection.merged.rootCause
    ? '\n\nExtraction reasoning:\n' + reflection.merged.rootCause
    : '';
  return `Extraction synthesis: extracted focused entry from ${sources.length} larger source(s).${note}\n\nSource entries:\n` + sources.map((s) => `  - ${s.id}`).join('\n');
}

function _renderRetireDescription({ sources, reflection }) {
  const list = sources.map((s) => `  - ${s.id} (${s.project}): ${(s.name || '').slice(0, 60)}`).join('\n');
  const reason = reflection && reflection.merged && reflection.merged.rootCause
    ? '\n\nRationale:\n' + reflection.merged.rootCause
    : '';
  return `Retirement recommendation: ${sources.length} entries flagged as stale or low-value.${reason}\n\nCandidates for retirement (require human approval):\n${list}\n\nRun knowledge-transition to formally retire. Audit ledger keeps the immutable record.`;
}

function _renderDescription(synthesisType, ctx) {
  switch (synthesisType) {
    case SYNTHESIS_TYPES.CONFLUENCE: return _renderConfluenceDescription(ctx);
    case SYNTHESIS_TYPES.CONTRADICTION: return _renderContradictionDescription(ctx);
    case SYNTHESIS_TYPES.ABSTRACTION: return _renderAbstractionDescription(ctx);
    case SYNTHESIS_TYPES.EXTRACTION: return _renderExtractionDescription(ctx);
    case SYNTHESIS_TYPES.RETIRE_RECOMMENDATION: return _renderRetireDescription(ctx);
    default: throw new Error('unknown synthesisType: ' + synthesisType);
  }
}

function buildSynthesis({
  sources,
  reflection = null,
  synthesisType,
  name,
  project,
  category = 'lessons',
  specialistId = null,
  consensusBonus = 0,
} = {}) {
  if (!Array.isArray(sources) || sources.length === 0) throw new Error('buildSynthesis: sources (non-empty array) required');
  if (!Object.values(SYNTHESIS_TYPES).includes(synthesisType)) {
    throw new Error('buildSynthesis: synthesisType must be one of ' + Object.values(SYNTHESIS_TYPES).join(' / '));
  }
  if (!name) throw new Error('buildSynthesis: name required');
  if (!project) throw new Error('buildSynthesis: project required');

  for (const s of sources) {
    if (!s.id || !s.project) throw new Error('buildSynthesis: each source needs id + project');
  }

  // Mean confidence across sources, weighted by reflection consensus if available.
  const meanSrcConfidence = _mean(sources.map((s) => typeof s.confidence === 'number' ? s.confidence : 0.8));
  const reflConsensus = reflection && reflection.agreement && typeof reflection.agreement.rootCauseConsensus === 'number'
    ? reflection.agreement.rootCauseConsensus
    : null;
  // If reflection consensus is high, bias confidence up; if low, bias down.
  // consensus null → no adjustment.
  let synthesisConfidence = meanSrcConfidence;
  if (reflConsensus !== null) {
    // Move synthesisConfidence toward 0.5 + reflConsensus*0.5 (so high consensus → high confidence).
    synthesisConfidence = (meanSrcConfidence + reflConsensus) / 2;
  }
  synthesisConfidence = Math.min(0.99, Math.max(0.05, synthesisConfidence + (consensusBonus || 0)));

  const description = _renderDescription(synthesisType, { sources, reflection });
  const createdAt = new Date().toISOString();

  const synthesisId = 'synth-' + crypto.createHash('sha256')
    .update(synthesisType + '|' + name + '|' + sources.map((s) => s.project + '/' + s.id).sort().join(','))
    .digest('hex').slice(0, 16);

  const synthesisEntry = {
    id: synthesisId,
    project,
    category,
    name,
    description,
    confidence: Number(synthesisConfidence.toFixed(3)),
    status: 'active',
    createdAt,
    synthesisType,
    synthesisSources: sources.map((s) => ({ id: s.id, project: s.project })),
    specialistId,
    reflectionRef: reflection ? {
      rootCause: reflection.merged && reflection.merged.rootCause ? reflection.merged.rootCause.slice(0, 240) : null,
      consensus: reflConsensus,
    } : null,
  };

  // Citation relationship rows the caller can append to kb_relationships.
  // Type 'confirms' for confluence/abstraction; 'contradicts' for contradiction;
  // 'qualifies' for extraction; 'deprecates' for retire-recommendation.
  const relType = ({
    [SYNTHESIS_TYPES.CONFLUENCE]: 'confirms',
    [SYNTHESIS_TYPES.CONTRADICTION]: 'contradicts',
    [SYNTHESIS_TYPES.ABSTRACTION]: 'confirms',
    [SYNTHESIS_TYPES.EXTRACTION]: 'qualifies',
    [SYNTHESIS_TYPES.RETIRE_RECOMMENDATION]: 'deprecates',
  })[synthesisType];

  const citationRelationships = sources.map((s) => ({
    source_id: synthesisId,
    source_project: project,
    target_id: s.id,
    target_project: s.project,
    type: relType,
    created_at: createdAt,
    weight: 1,
  }));

  return { synthesisEntry, citationRelationships };
}

function appendSynthesisLedger({ synthesisEntry, citationRelationships }, opts = {}) {
  const filePath = ledgerPath(opts);
  ensureFile(filePath);
  const existing = readLedger(filePath);
  const previous = existing[existing.length - 1] || null;
  const descHash = 'sha256:' + crypto.createHash('sha256').update(synthesisEntry.description || '').digest('hex');
  const entry = {
    sequence: existing.length + 1,
    previousHash: previous ? previous.entryHash : null,
    synthesisId: synthesisEntry.id,
    synthesisType: synthesisEntry.synthesisType,
    project: synthesisEntry.project,
    name: synthesisEntry.name,
    descriptionHash: descHash,
    confidence: synthesisEntry.confidence,
    sourceIds: synthesisEntry.synthesisSources.map((s) => s.id),
    sourceProjects: synthesisEntry.synthesisSources.map((s) => s.project),
    citationRelationshipCount: citationRelationships.length,
    reflectionRef: synthesisEntry.reflectionRef,
    specialistId: synthesisEntry.specialistId,
    createdAt: synthesisEntry.createdAt,
  };
  entry.entryHash = _entryHash(entry);
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function listSyntheses(opts = {}) {
  const entries = readLedger(ledgerPath(opts));
  if (opts.project) return entries.filter((e) => e.project === opts.project);
  return entries;
}

function verifySynthesisLedger(opts = {}) {
  const filePath = ledgerPath(opts);
  if (!fs.existsSync(filePath)) return { ok: true, entries: 0, message: 'no_ledger_yet' };
  const entries = readLedger(filePath);
  let prev = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.sequence !== i + 1) return { ok: false, failedAt: i + 1, reason: 'sequence_gap' };
    if (e.previousHash !== (prev ? prev.entryHash : null)) return { ok: false, failedAt: i + 1, reason: 'previous_hash_mismatch' };
    if (_entryHash(e) !== e.entryHash) return { ok: false, failedAt: i + 1, reason: 'entry_hash_mismatch' };
    prev = e;
  }
  return { ok: true, entries: entries.length, headHash: prev ? prev.entryHash : null };
}

module.exports = {
  buildSynthesis,
  appendSynthesisLedger,
  listSyntheses,
  verifySynthesisLedger,
  SYNTHESIS_TYPES,
};
