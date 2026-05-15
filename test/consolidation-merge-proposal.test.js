'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PROPOSAL_STATES,
  buildMergeProposal,
  writeMergeProposal,
  readMergeProposals,
  setProposalState,
  applyMergeProposal,
} = require('../lib/consolidation/merge-proposal');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recall-merge-proposal-'));
}

function validCluster(overrides = {}) {
  return {
    id: 'cluster-test-1',
    memberIds: ['e1', 'e2', 'e3'],
    memberSummaries: [
      { id: 'e1', name: 'first', descriptionPreview: 'preview1' },
      { id: 'e2', name: 'second', descriptionPreview: 'preview2' },
      { id: 'e3', name: 'third', descriptionPreview: 'preview3' },
    ],
    avgSimilarity: 0.85,
    pairCount: 3,
    ...overrides,
  };
}

function validJudgement(overrides = {}) {
  return {
    isDuplicate: true,
    confidence: 0.9,
    synthesis: { name: 'canonical', description: 'unified description' },
    rationale: 'all three describe the same thing',
    perEntryNotes: [
      { id: 'e1', role: 'canonical', note: 'cleanest' },
      { id: 'e2', role: 'redundant', note: 'covered' },
      { id: 'e3', role: 'partial', note: 'adds one detail' },
    ],
    model: 'mock-model',
    judgedAt: '2026-05-12T20:00:00.000Z',
    parseFailed: false,
    ...overrides,
  };
}

describe('merge-proposal / buildMergeProposal', () => {
  test('throws on missing cluster, judgement, or project', () => {
    expect(() => buildMergeProposal({ judgement: validJudgement(), project: 'p' })).toThrow(/cluster/);
    expect(() => buildMergeProposal({ cluster: validCluster(), project: 'p' })).toThrow(/judgement/);
    expect(() => buildMergeProposal({ cluster: validCluster(), judgement: validJudgement() })).toThrow(/project/);
  });

  test('produces a proposal with id, state=proposed, embedded cluster + judgement + provenance', () => {
    const proposal = buildMergeProposal({
      cluster: validCluster(),
      judgement: validJudgement(),
      project: 'recall-dev',
      category: 'decisions',
    });
    expect(proposal.id).toMatch(/^merge-recall-dev-decisions-cluster-test-1-/);
    expect(proposal.state).toBe('proposed');
    expect(proposal.project).toBe('recall-dev');
    expect(proposal.category).toBe('decisions');
    expect(proposal.cluster.memberIds).toEqual(['e1', 'e2', 'e3']);
    expect(proposal.judgement.synthesis.name).toBe('canonical');
    expect(proposal.provenance.author_type).toBe('consolidation-slice-1-proposed');
    expect(proposal.appliedAt).toBeNull();
  });

  test('PROPOSAL_STATES set covers proposed/approved/rejected/applied', () => {
    expect(PROPOSAL_STATES.has('proposed')).toBe(true);
    expect(PROPOSAL_STATES.has('approved')).toBe(true);
    expect(PROPOSAL_STATES.has('rejected')).toBe(true);
    expect(PROPOSAL_STATES.has('applied')).toBe(true);
  });
});

describe('merge-proposal / writeMergeProposal + readMergeProposals', () => {
  let outputDir;

  beforeEach(() => { outputDir = tempDir(); });
  afterEach(() => { try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (_) { /* noop */ } });

  test('round-trips a proposal to disk and back', () => {
    const proposal = buildMergeProposal({
      cluster: validCluster(),
      judgement: validJudgement(),
      project: 'recall-dev',
      category: 'lessons',
    });
    const filePath = writeMergeProposal(proposal, { outputDir });
    expect(fs.existsSync(filePath)).toBe(true);

    const list = readMergeProposals({ outputDir });
    expect(list).toHaveLength(1);
    expect(list[0].proposal.id).toBe(proposal.id);
    expect(list[0].file).toBe(filePath);
    expect(list[0].proposal.judgement.synthesis.name).toBe('canonical');
  });

  test('readMergeProposals filters by project when provided', () => {
    const a = buildMergeProposal({ cluster: validCluster({ id: 'c-a' }), judgement: validJudgement(), project: 'recall-dev', category: 'decisions' });
    const b = buildMergeProposal({ cluster: validCluster({ id: 'c-b' }), judgement: validJudgement(), project: 'sample-bot-project', category: 'lessons' });
    writeMergeProposal(a, { outputDir });
    writeMergeProposal(b, { outputDir });

    const onlyRecall = readMergeProposals({ outputDir, project: 'recall-dev' });
    expect(onlyRecall).toHaveLength(1);
    expect(onlyRecall[0].proposal.project).toBe('recall-dev');
  });

  test('returns empty list when no directory or no files', () => {
    expect(readMergeProposals({ outputDir })).toEqual([]);
    expect(readMergeProposals({ outputDir: path.join(outputDir, 'nonexistent') })).toEqual([]);
  });
});

describe('merge-proposal / setProposalState', () => {
  let outputDir;
  let proposalId;

  beforeEach(() => {
    outputDir = tempDir();
    const p = buildMergeProposal({ cluster: validCluster(), judgement: validJudgement(), project: 'p', category: 'decisions' });
    writeMergeProposal(p, { outputDir });
    proposalId = p.id;
  });

  afterEach(() => { try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (_) { /* noop */ } });

  test('updates state in-place and writes back to disk', () => {
    const updated = setProposalState(proposalId, 'approved', { outputDir });
    expect(updated.state).toBe('approved');
    expect(updated.provenance.approvedAt).toBeTruthy();

    const reRead = readMergeProposals({ outputDir })[0].proposal;
    expect(reRead.state).toBe('approved');
  });

  test('rejects unknown state', () => {
    expect(() => setProposalState(proposalId, 'destroyed', { outputDir })).toThrow(/Invalid proposal state/);
  });

  test('throws on missing proposal', () => {
    expect(() => setProposalState('nonexistent-id', 'approved', { outputDir })).toThrow(/Proposal not found/);
  });
});

describe('merge-proposal / applyMergeProposal', () => {
  let outputDir;

  beforeEach(() => { outputDir = tempDir(); });
  afterEach(() => { try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (_) { /* noop */ } });

  test('refuses to apply when judgement.isDuplicate=false', () => {
    const proposal = buildMergeProposal({
      cluster: validCluster(),
      judgement: validJudgement({ isDuplicate: false, synthesis: null }),
      project: 'p', category: 'decisions',
    });
    const kb = { addEntry: () => { throw new Error('should not be called'); }, updateEntry: () => {} };
    const result = applyMergeProposal({ proposal, kb });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('judgement_not_duplicate');
  });

  test('refuses to apply when synthesis is missing', () => {
    const proposal = buildMergeProposal({
      cluster: validCluster(),
      judgement: validJudgement({ synthesis: null }),
      project: 'p', category: 'decisions',
    });
    const kb = { addEntry: () => ({}), updateEntry: () => {} };
    const result = applyMergeProposal({ proposal, kb });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('no_synthesis');
  });

  test('dry-run (default) returns wouldWriteSynthesis + wouldSupersede, does NOT call kb.addEntry', () => {
    const proposal = buildMergeProposal({ cluster: validCluster(), judgement: validJudgement(), project: 'p', category: 'decisions' });
    let addCalled = false;
    let updateCalled = false;
    const kb = {
      addEntry: () => { addCalled = true; return {}; },
      updateEntry: () => { updateCalled = true; },
    };
    const result = applyMergeProposal({ proposal, kb });
    expect(addCalled).toBe(false);
    expect(updateCalled).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('dry_run');
    expect(result.wouldWriteSynthesis.name).toBe('canonical');
    expect(result.wouldWriteSynthesis.provenance.author_type).toBe('consolidation-synthesis');
    expect(result.wouldSupersede).toEqual(['e2', 'e3']);
    expect(result.wouldRetainCanonical).toEqual(['e1']);
  });

  test('commit=true writes synthesis + supersedes redundant/partial members', () => {
    const proposal = buildMergeProposal({ cluster: validCluster(), judgement: validJudgement(), project: 'p', category: 'decisions' });
    const writes = { add: null, updates: [] };
    const kb = {
      addEntry: (project, entry) => {
        writes.add = { project, entry };
        return { id: 'synth-id-123', name: entry.name, category: entry.category };
      },
      updateEntry: (project, id, patch) => {
        writes.updates.push({ project, id, patch });
      },
    };
    const result = applyMergeProposal({ proposal, kb, commit: true });
    expect(result.applied).toBe(true);
    expect(result.synthesisEntry.id).toBe('synth-id-123');
    expect(result.supersededIds.sort()).toEqual(['e2', 'e3']);
    expect(result.canonicalIds).toEqual(['e1']);
    expect(writes.add.project).toBe('p');
    expect(writes.updates.map((u) => u.id).sort()).toEqual(['e2', 'e3']);
    for (const u of writes.updates) {
      expect(u.patch.status).toBe('retired');
      expect(u.patch.supersededBy).toBe('synth-id-123');
    }
  });

  test('refuses to re-apply an already-applied proposal', () => {
    const proposal = buildMergeProposal({ cluster: validCluster(), judgement: validJudgement(), project: 'p', category: 'decisions' });
    proposal.state = 'applied';
    proposal.appliedEntryId = 'synth-x';
    const kb = { addEntry: () => { throw new Error('should not be called'); }, updateEntry: () => {} };
    const result = applyMergeProposal({ proposal, kb, commit: true });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('already_applied');
  });

  test('captures supersede errors without aborting', () => {
    const proposal = buildMergeProposal({ cluster: validCluster(), judgement: validJudgement(), project: 'p', category: 'decisions' });
    const kb = {
      addEntry: () => ({ id: 'synth-1' }),
      updateEntry: (project, id) => {
        if (id === 'e3') throw new Error('e3 not found');
      },
    };
    const result = applyMergeProposal({ proposal, kb, commit: true });
    expect(result.applied).toBe(true);
    expect(result.supersedeErrors).toHaveLength(1);
    expect(result.supersedeErrors[0].id).toBe('e3');
  });

  test('returns kb_addEntry_failed when synthesis write throws', () => {
    const proposal = buildMergeProposal({ cluster: validCluster(), judgement: validJudgement(), project: 'p', category: 'decisions' });
    const kb = {
      addEntry: () => { throw new Error('disk full'); },
      updateEntry: () => {},
    };
    const result = applyMergeProposal({ proposal, kb, commit: true });
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/kb_addEntry_failed.*disk full/);
  });

  test('requires kb to implement addEntry AND updateEntry', () => {
    const proposal = buildMergeProposal({ cluster: validCluster(), judgement: validJudgement(), project: 'p', category: 'decisions' });
    expect(() => applyMergeProposal({ proposal, kb: {}, commit: true })).toThrow(/addEntry.*updateEntry/);
    expect(() => applyMergeProposal({ proposal, kb: { addEntry: () => {} }, commit: true })).toThrow(/addEntry.*updateEntry/);
  });
});
