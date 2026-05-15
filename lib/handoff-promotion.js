'use strict';

// Interim handoff-promotion module — bridge between the Codex agent handoff
// ledger (lib/agent-handoff-ledger) and the KB until Trace Optimizer ships.
//
// Walks significant + succeeded agent handoff JSONs and produces draft KB
// promotion payloads (decision / milestone / lesson) tiered by confidence:
//
//   confidence >= autoThreshold (default 0.8) -> auto-promote queue
//   confidence >= queueThreshold (default 0.5) -> human-review queue
//   confidence <  queueThreshold              -> discarded
//
// Drafts are written to disk for human approval before they hit the KB.
// Auto-promotion still requires a downstream step (the Trace Optimizer
// MeridianPromotionPort, when it ships) that writes via meridian-core.
// Until then this module is the explicit Trace Optimizer stub.

const fs = require('fs');
const path = require('path');
const agentHandoffs = require('./agent-handoff-ledger');

const HANDOFF_DIR_DEFAULT = path.join('docs', 'agent-handoffs');

function listHandoffFiles(sourceDir) {
  if (!fs.existsSync(sourceDir)) return [];
  return fs.readdirSync(sourceDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(sourceDir, name));
}

function readHandoffSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
}

// Confidence heuristic. Base 0.5; +0.1 for each piece of evidence the
// handoff already carries. Capped at 0.95. Intentionally simple so the
// behavior is easy to reason about and override per-project.
function scoreConfidence(handoff) {
  let score = 0.5;
  if (handoff.outcome === 'succeeded') score += 0.1;
  if ((handoff.testsRun || []).length > 0) score += 0.1;
  if ((handoff.actualOutputs || []).length >= 3) score += 0.1;
  if ((handoff.reviewFindings || []).length >= 2) score += 0.1;
  if ((handoff.filesTouched || []).length >= 5) score += 0.1;
  return Math.min(0.95, Number(score.toFixed(2)));
}

function inferDraftType(handoff) {
  const rec = handoff.promotionRecommendation;
  if (rec === 'candidate_milestone') return 'milestone';
  if (rec === 'candidate_lesson') return 'lesson';
  if (rec === 'candidate_decision') return 'decision';
  const taskType = handoff.taskType || '';
  if (taskType === 'planning' || taskType === 'process-rule') return 'decision';
  if (taskType === 'review') return 'lesson';
  return 'decision';
}

function formatList(items, label) {
  const cleaned = (items || [])
    .map((item) => (typeof item === 'string' ? item : (item && item.summary) || JSON.stringify(item)))
    .filter(Boolean);
  if (cleaned.length === 0) return '';
  return `${label}:\n- ${cleaned.join('\n- ')}`;
}

function buildDraft(handoff, sourcePath) {
  const type = inferDraftType(handoff);
  const confidence = scoreConfidence(handoff);
  const title = (handoff.taskSummary || '(no task summary)').slice(0, 200);

  const rationale = [
    handoff.selectedBecause || '',
    formatList(handoff.actualOutputs, 'Outputs'),
    formatList(handoff.reviewFindings, 'Findings'),
    formatList(handoff.draftLessons, 'Draft lessons'),
  ].filter(Boolean).join('\n\n');

  // KB-shaped payloads — match the existing recall_decision / recall_milestone
  // / recall_kb (lessons) tool signatures. Caller can hand these directly to
  // the corresponding MCP tool or CLI without further reshaping.
  let payload;
  if (type === 'milestone') {
    payload = {
      project_id: handoff.project || 'recall-dev',
      action: 'add',
      title,
      notes: rationale,
    };
  } else if (type === 'lesson') {
    payload = {
      project_id: handoff.project || 'recall-dev',
      action: 'add',
      category: 'lessons',
      name: title,
      description: rationale,
    };
  } else {
    payload = {
      project_id: handoff.project || 'recall-dev',
      action: 'add',
      title,
      rationale,
      alternatives: '',
      severity: confidence >= 0.8 ? 'high' : 'medium',
    };
  }

  return {
    type,
    payload,
    provenance: {
      sourceHandoffId: handoff.id || path.basename(sourcePath, '.json'),
      sourceHandoffPath: sourcePath,
      author_type: 'il-auto-promoted',
      confidence,
      proposedAt: new Date().toISOString(),
    },
  };
}

function buildPromotionQueue({ project, since, sourceDir, threshold } = {}) {
  const dir = sourceDir || HANDOFF_DIR_DEFAULT;
  const files = listHandoffFiles(dir);
  const sinceMs = since ? new Date(since).getTime() : 0;
  const autoThreshold = (threshold && Number.isFinite(threshold.autoPromote)) ? threshold.autoPromote : 0.8;
  const queueThreshold = (threshold && Number.isFinite(threshold.queue)) ? threshold.queue : 0.5;

  const results = { autoPromote: [], queueForReview: [], discarded: [] };

  for (const file of files) {
    const raw = readHandoffSafe(file);
    if (!raw) continue;
    if (project && raw.project && raw.project !== project) continue;
    if (sinceMs > 0) {
      const createdMs = new Date(raw.createdAt || raw.updatedAt || 0).getTime();
      if (!Number.isFinite(createdMs) || createdMs < sinceMs) continue;
    }
    const normalized = agentHandoffs.normalizeHandoff(raw);
    if (!agentHandoffs.isSignificantHandoff(normalized)) continue;
    if (normalized.outcome !== 'succeeded') continue;

    const draft = buildDraft(normalized, file);

    if (draft.provenance.confidence >= autoThreshold) {
      results.autoPromote.push(draft);
    } else if (draft.provenance.confidence >= queueThreshold) {
      results.queueForReview.push(draft);
    } else {
      results.discarded.push(draft);
    }
  }

  return results;
}

function writeDrafts(drafts, outputDir) {
  if (!drafts || drafts.length === 0) return 0;
  fs.mkdirSync(outputDir, { recursive: true });
  for (const draft of drafts) {
    const id = `${draft.type}-${draft.provenance.sourceHandoffId}.json`;
    const filePath = path.join(outputDir, id);
    fs.writeFileSync(filePath, JSON.stringify(draft, null, 2));
  }
  return drafts.length;
}

module.exports = {
  HANDOFF_DIR_DEFAULT,
  listHandoffFiles,
  readHandoffSafe,
  scoreConfidence,
  inferDraftType,
  buildDraft,
  buildPromotionQueue,
  writeDrafts,
};
