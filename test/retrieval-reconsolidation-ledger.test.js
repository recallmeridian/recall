'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  appendRetrievalReconsolidationRecord,
  readRetrievalReconsolidationLedger,
  verifyRetrievalReconsolidationLedger,
} = require('../lib/retrieval-reconsolidation-ledger');

function event(overrides = {}) {
  return {
    schemaVersion: 'retrieval_reconsolidation_candidate/v1',
    eventType: 'retrieval_reconsolidation_candidate',
    eventId: overrides.eventId || 'event-1',
    retrievalDecision: overrides.retrievalDecision || 'allow',
    projectId: overrides.projectId || 'recall-dev',
    candidate: {
      id: overrides.candidateId || 'entry-1',
      projectId: overrides.projectId || 'recall-dev',
      sourceProjectId: overrides.sourceProjectId || 'research',
      partition: 'trusted_kb',
      source_trust_level: 'trusted',
    },
    observation: {
      retrieved: true,
    },
    proposedEffects: ['observe_retrieval', 'cross_project_bridge_candidate'],
    policy: {
      effect: 'report_only',
      mayMutateMemory: false,
      mayChangeRanking: false,
      requiresPromotionBeforeMutation: true,
    },
  };
}

describe('Retrieval Reconsolidation Ledger', () => {
  let dir;
  let ledgerPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconsolidation-ledger-'));
    ledgerPath = path.join(dir, 'ledger.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('appends report-only retrieval reconsolidation events as a hash chain', () => {
    const first = appendRetrievalReconsolidationRecord(ledgerPath, event({ eventId: 'event-1' }), {
      actor: 'test-runner',
      projectId: 'recall-dev',
      now: '2026-05-05T00:00:00.000Z',
    });
    const second = appendRetrievalReconsolidationRecord(ledgerPath, event({ eventId: 'event-2', candidateId: 'entry-2' }), {
      actor: 'test-runner',
      projectId: 'recall-dev',
      now: '2026-05-05T00:01:00.000Z',
    });

    expect(first).toMatchObject({
      schemaVersion: 'retrieval_reconsolidation_ledger_record/v1',
      sequence: 1,
      previousHash: null,
      eventId: 'event-1',
      actor: 'test-runner',
    });
    expect(second).toMatchObject({
      sequence: 2,
      previousHash: first.recordHash,
      eventId: 'event-2',
    });
    expect(readRetrievalReconsolidationLedger(ledgerPath)).toHaveLength(2);
    expect(verifyRetrievalReconsolidationLedger(ledgerPath)).toMatchObject({
      ok: true,
      count: 2,
      errors: [],
      lastHash: second.recordHash,
    });
  });

  test('rejects events that would mutate memory or ranking', () => {
    expect(() => appendRetrievalReconsolidationRecord(ledgerPath, {
      ...event(),
      policy: {
        effect: 'promote',
        mayMutateMemory: true,
      },
    })).toThrow('report-only events only');
    expect(fs.existsSync(ledgerPath)).toBe(false);
  });

  test('verification fails closed on tampered records', () => {
    appendRetrievalReconsolidationRecord(ledgerPath, event({ eventId: 'event-1' }));
    const records = readRetrievalReconsolidationLedger(ledgerPath);
    records[0].event.candidate.source_trust_level = 'untrusted';
    fs.writeFileSync(ledgerPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

    expect(verifyRetrievalReconsolidationLedger(ledgerPath)).toMatchObject({
      ok: false,
      count: 1,
      errors: expect.arrayContaining([
        'record_hash_mismatch:1',
        'event_hash_mismatch:1',
      ]),
    });
  });
});
