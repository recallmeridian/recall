'use strict';

// OpenClaw runtime stub — the producer side of the OpenClaw audit
// contract. Closes the loop on Codex's 5-slice #3 (Audit Ingest):
// today's audit-ingest is the receiver; this is the first real producer.
//
// Design intent (per the 2026-05-12 brainstorm):
//   • OpenClaw is the posting / messaging agent. It proposes ACTIONS
//     to Recall (the Governor); Recall decides allow / block / review.
//   • OpenClaw never has private memory. It REQUESTS scoped context
//     per action and gets back what Recall hands.
//   • Every action OpenClaw takes (or tries to) gets recorded in
//     Recall's audit-ingest ledger as UNTRUSTED.
//
// This is a STUB. It doesn't actually post to Moltbook, send tweets,
// hit any external API. What it does:
//   1. Take a ProposedAction in
//   2. Run it through the egress DLP scanner
//   3. Submit it to the audit-ingest ledger (untrusted-by-default)
//   4. Return the gate decision + record id
//
// When OpenClaw becomes a real agent, the only change is step 5:
// actually execute the action if the gate says allow. Everything else
// stays the same.
//
// API:
//   await processProposedAction({action, agentId?, dataDir?})
//     → { decision, recordId, dlpResult, blockers, warnings, rationale }

const { scanContent } = require('../security/egress-scanner');
const { submitAuditRecord } = require('../security/audit-ingest');

const DEFAULT_AGENT_ID = 'openclaw-runtime-stub';

function _contentFromAction(action) {
  if (!action || typeof action !== 'object') return '';
  // Most actions have a text-bearing target. Pull whatever's there.
  if (action.target && typeof action.target === 'object') {
    const candidates = ['text', 'body', 'content', 'message', 'caption'];
    for (const k of candidates) {
      if (typeof action.target[k] === 'string') return action.target[k];
    }
  }
  if (typeof action.content === 'string') return action.content;
  return '';
}

function _gateDecision(action, dlpResult) {
  // The runtime's gate decision is a function of (DLP decision +
  // actionKind). The brainstorm doctrine: egress always reviews.
  const dlp = dlpResult.decision;
  const kind = action.actionKind || 'unknown';

  // Read-only retrieval with no external surface: allow.
  if (kind === 'read_kb' || kind === 'retrieval') {
    return { decision: 'allow', reason: 'read-only KB retrieval; no external surface touched' };
  }

  // Anything with a DLP block: block.
  if (dlp === 'block') {
    return { decision: 'block', reason: 'DLP detected high-severity leak in proposed content' };
  }

  // Egress (post / http_request / file_write to external) defaults to
  // review even if content is clean.
  const egressKinds = ['post', 'http_request', 'tool_call', 'file_write', 'publish'];
  if (egressKinds.includes(kind)) {
    return { decision: 'review', reason: dlp === 'review'
      ? 'DLP review-level findings + egress action'
      : 'egress action — review boundary per Codex doctrine' };
  }

  // Default: review.
  return { decision: 'review', reason: 'unknown action kind; default to review' };
}

async function processProposedAction({ action, agentId, dataDir, target: targetOverride } = {}) {
  if (!action || typeof action !== 'object') {
    throw new Error('action must be an object with at least actionKind + target');
  }
  if (!action.actionKind) throw new Error('action.actionKind is required');

  const effectiveAgentId = agentId || DEFAULT_AGENT_ID;

  // 1. Run DLP scan over the action's text content (if any).
  const content = _contentFromAction(action);
  const dlpResult = content
    ? scanContent({ content, kind: 'openclaw-proposed-action', target: targetOverride || JSON.stringify(action.target) })
    : { decision: 'allow', blockers: [], warnings: [], contentHash: 'sha256:empty', scanId: 'no-content' };

  // 2. Compute the gate decision from DLP + actionKind.
  const gate = _gateDecision(action, dlpResult);

  // 3. Record the proposal in the audit-ingest ledger (untrusted by
  // default). The outcome reflects the gate decision: if we blocked,
  // outcome=blocked; if we'd allow, outcome=attempted (the real
  // OpenClaw would update this to succeeded/errored after executing).
  const outcomeForGate = gate.decision === 'block' ? 'blocked' : 'attempted';
  const submit = submitAuditRecord({
    agentId: effectiveAgentId,
    actionKind: action.actionKind,
    target: action.target || null,
    rationale: action.rationale || gate.reason,
    outcome: outcomeForGate,
    evidence: action.evidence || [],
    contentHash: dlpResult.contentHash,
  }, { dataDir });

  return {
    decision: gate.decision,
    reason: gate.reason,
    recordId: submit.recordId,
    dlpDecision: dlpResult.decision,
    blockers: dlpResult.blockers || [],
    warnings: dlpResult.warnings || [],
  };
}

module.exports = {
  processProposedAction,
};
