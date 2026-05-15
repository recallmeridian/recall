'use strict';

// Consolidation — Slice 1b: merge-proposal lifecycle.
//
// A MergeProposal is built from a Cluster + ClusterJudgement. It's a
// rollback-able artifact representing "this is what I propose we do
// with these N entries." Three states: proposed, approved, applied.
// Stored as JSON files under ~/.recall/pending-consolidation/<project>/.
//
// Apply step is NEVER destructive. Originals are marked superseded
// (status='retired', supersededBy set), but the rows stay in the KB.
// A new SYNTHESIS entry is added that lists the originals as
// `provenance.derivedFrom`. Same trail Trace Optimizer Slice 4 uses.
//
// Per-doctrine rule (decision-1777317024151 Truth/Evidence/Promotion):
// proposals never auto-apply. The CLI requires --commit to actually
// touch the KB; default is dry-run.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PROPOSAL_STATES = new Set(['proposed', 'approved', 'rejected', 'applied']);

function defaultPendingDir() {
  return path.join(os.homedir(), '.recall', 'pending-consolidation');
}

function shortId() {
  return crypto.randomBytes(6).toString('hex');
}

function safeFileName(s) {
  return String(s || 'unknown').replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 80);
}

function buildMergeProposal({ cluster, judgement, project, category }) {
  if (!cluster || !cluster.id) throw new Error('buildMergeProposal: cluster is required');
  if (!judgement) throw new Error('buildMergeProposal: judgement is required');
  if (!project) throw new Error('buildMergeProposal: project is required');

  const id = `merge-${safeFileName(project)}-${safeFileName(category || 'mixed')}-${cluster.id}-${shortId()}`;
  return {
    id,
    state: 'proposed',
    project,
    category: category || cluster.category || 'unknown',
    cluster: {
      id: cluster.id,
      memberIds: cluster.memberIds,
      memberSummaries: cluster.memberSummaries,
      avgSimilarity: cluster.avgSimilarity,
      pairCount: cluster.pairCount,
    },
    judgement: {
      isDuplicate: judgement.isDuplicate,
      confidence: judgement.confidence,
      rationale: judgement.rationale,
      synthesis: judgement.synthesis,
      perEntryNotes: judgement.perEntryNotes,
      model: judgement.model,
      judgedAt: judgement.judgedAt,
      parseFailed: judgement.parseFailed,
    },
    provenance: {
      author_type: 'consolidation-slice-1-proposed',
      proposedAt: new Date().toISOString(),
    },
    appliedAt: null,
    appliedEntryId: null,
  };
}

function writeMergeProposal(proposal, opts = {}) {
  const dir = opts.outputDir || defaultPendingDir();
  const projectDir = path.join(dir, safeFileName(proposal.project));
  fs.mkdirSync(projectDir, { recursive: true });
  const fp = path.join(projectDir, `${proposal.id}.json`);
  fs.writeFileSync(fp, JSON.stringify(proposal, null, 2));
  return fp;
}

function readMergeProposals(opts = {}) {
  const dir = opts.outputDir || defaultPendingDir();
  if (!fs.existsSync(dir)) return [];
  const projects = opts.project ? [opts.project] : fs.readdirSync(dir).filter((d) => {
    try { return fs.statSync(path.join(dir, d)).isDirectory(); } catch (_) { return false; }
  });
  const out = [];
  for (const project of projects) {
    const projectDir = path.join(dir, safeFileName(project));
    if (!fs.existsSync(projectDir)) continue;
    for (const file of fs.readdirSync(projectDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const proposal = JSON.parse(fs.readFileSync(path.join(projectDir, file), 'utf8'));
        out.push({ proposal, file: path.join(projectDir, file) });
      } catch (_) { /* skip malformed */ }
    }
  }
  return out;
}

function getMergeProposal(proposalId, opts = {}) {
  const all = readMergeProposals(opts);
  return all.find((p) => p.proposal.id === proposalId) || null;
}

function setProposalState(proposalId, newState, opts = {}) {
  if (!PROPOSAL_STATES.has(newState)) {
    throw new Error(`Invalid proposal state: ${newState}. Must be one of: ${[...PROPOSAL_STATES].join(', ')}`);
  }
  const found = getMergeProposal(proposalId, opts);
  if (!found) throw new Error(`Proposal not found: ${proposalId}`);
  found.proposal.state = newState;
  found.proposal.provenance[`${newState}At`] = new Date().toISOString();
  fs.writeFileSync(found.file, JSON.stringify(found.proposal, null, 2));
  return found.proposal;
}

// Apply a proposal: write a synthesis entry that cites originals, mark
// originals as superseded. Caller passes a kb handle; tests pass a stub.
//
// Default behavior is dry-run: returns what WOULD happen, makes no
// writes. opts.commit=true performs the writes.
function applyMergeProposal({ proposal, kb, commit = false }) {
  if (!proposal || !proposal.id) throw new Error('applyMergeProposal: proposal is required');
  if (!kb || typeof kb.addEntry !== 'function' || typeof kb.updateEntry !== 'function') {
    throw new Error('applyMergeProposal: kb must implement addEntry + updateEntry');
  }
  if (!proposal.judgement || !proposal.judgement.isDuplicate) {
    return {
      applied: false,
      reason: 'judgement_not_duplicate',
      proposalId: proposal.id,
    };
  }
  if (!proposal.judgement.synthesis || !proposal.judgement.synthesis.name) {
    return {
      applied: false,
      reason: 'no_synthesis',
      proposalId: proposal.id,
    };
  }
  if (proposal.state === 'applied') {
    return {
      applied: false,
      reason: 'already_applied',
      proposalId: proposal.id,
      appliedEntryId: proposal.appliedEntryId,
    };
  }

  const synthesis = proposal.judgement.synthesis;
  const supersededIds = (proposal.judgement.perEntryNotes || [])
    .filter((n) => n.role === 'redundant' || n.role === 'partial')
    .map((n) => n.id);
  const canonicalIds = (proposal.judgement.perEntryNotes || [])
    .filter((n) => n.role === 'canonical')
    .map((n) => n.id);

  const synthesisEntry = {
    name: synthesis.name,
    category: proposal.category,
    description: synthesis.description,
    status: 'active',
    sourceProposalId: proposal.id,
    provenance: {
      author_type: 'consolidation-synthesis',
      derivedFrom: proposal.cluster.memberIds,
      canonicalIds,
      supersededIds,
      mergeProposalId: proposal.id,
      synthesizedAt: new Date().toISOString(),
    },
  };

  if (!commit) {
    return {
      applied: false,
      reason: 'dry_run',
      proposalId: proposal.id,
      wouldWriteSynthesis: synthesisEntry,
      wouldSupersede: supersededIds,
      wouldRetainCanonical: canonicalIds,
    };
  }

  let createdEntry;
  try {
    createdEntry = kb.addEntry(proposal.project, synthesisEntry);
  } catch (err) {
    return {
      applied: false,
      reason: `kb_addEntry_failed: ${err.message}`,
      proposalId: proposal.id,
    };
  }

  const supersedeErrors = [];
  for (const id of supersededIds) {
    try {
      kb.updateEntry(proposal.project, id, {
        status: 'retired',
        supersededBy: createdEntry.id,
        retiredAt: new Date().toISOString(),
      });
    } catch (err) {
      supersedeErrors.push({ id, error: err.message });
    }
  }

  return {
    applied: true,
    proposalId: proposal.id,
    synthesisEntry: createdEntry,
    supersededIds,
    canonicalIds,
    supersedeErrors,
  };
}

module.exports = {
  PROPOSAL_STATES,
  defaultPendingDir,
  buildMergeProposal,
  writeMergeProposal,
  readMergeProposals,
  getMergeProposal,
  setProposalState,
  applyMergeProposal,
};
