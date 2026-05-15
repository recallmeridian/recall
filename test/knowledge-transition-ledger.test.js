'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { KNOWLEDGE_STATES } = require('../lib/knowledge-lifecycle');
const {
  appendKnowledgeTransitionRecord,
  buildRollbackPlan,
  historyForArtifact,
  normalizeTransitionEvent,
  readKnowledgeTransitionLedger,
  verifyKnowledgeTransitionLedger,
} = require('../lib/knowledge-transition-ledger');

function tempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-transition-'));
  return {
    dir,
    ledgerPath: path.join(dir, 'knowledge-transitions.jsonl'),
  };
}

describe('Knowledge Transition Ledger', () => {
  test('appends an evidence-backed promotion as a tamper-evident record', () => {
    const { dir, ledgerPath } = tempLedger();
    try {
      const record = appendKnowledgeTransitionRecord(ledgerPath, {
        artifactId: 'lesson-1',
        from: KNOWLEDGE_STATES.CANDIDATE_BELIEF,
        to: KNOWLEDGE_STATES.VALIDATED_KNOWLEDGE,
        reasons: ['verified by evaluator run'],
        evidenceRefs: ['recall://benchmark/run-1'],
        entry: {
          entryType: 'lesson',
          evidenceTypes: ['source_trace', 'outcome_evidence'],
        },
      }, {
        actor: 'jesse',
        now: '2026-05-05T00:00:00.000Z',
      });

      expect(record).toMatchObject({
        schemaVersion: 'knowledge_transition_ledger_record/v1',
        sequence: 1,
        previousHash: null,
        actor: 'jesse',
        artifactId: 'lesson-1',
        event: {
          status: 'accepted',
          action: 'promote',
          from: 'candidate_belief',
          to: 'validated_knowledge',
          policy: {
            mayMutateKnowledge: true,
            automaticExternalPromotionAllowed: false,
          },
        },
      });
      expect(verifyKnowledgeTransitionLedger(ledgerPath)).toMatchObject({
        ok: true,
        count: 1,
        errors: [],
      });
      expect(readKnowledgeTransitionLedger(ledgerPath)).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('blocks unsupported or external automatic promotion before writing', () => {
    const { dir, ledgerPath } = tempLedger();
    try {
      const blocked = normalizeTransitionEvent({
        artifactId: 'external-claim-1',
        from: KNOWLEDGE_STATES.CANDIDATE_BELIEF,
        to: KNOWLEDGE_STATES.VALIDATED_KNOWLEDGE,
        evidenceRefs: ['recall://source/web-claim'],
        reasons: ['looks plausible'],
        partition: 'candidate_basin',
        source_trust_level: 'external_low',
        entry: {
          entryType: 'skill',
          evidenceTypes: ['source_trace'],
        },
      }, {
        actor: 'agent',
        now: '2026-05-05T00:00:00.000Z',
      });

      expect(blocked.status).toBe('blocked');
      expect(blocked.errors).toEqual(expect.arrayContaining([
        'external_knowledge_requires_human_approval',
        'promotion_gate_missing:evaluation_evidence',
      ]));
      expect(() => appendKnowledgeTransitionRecord(ledgerPath, blocked)).toThrow('Knowledge transition blocked');
      expect(fs.existsSync(ledgerPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('records demotion and creates rollback plan from transition history', () => {
    const { dir, ledgerPath } = tempLedger();
    try {
      appendKnowledgeTransitionRecord(ledgerPath, {
        artifactId: 'rule-1',
        from: KNOWLEDGE_STATES.CANDIDATE_BELIEF,
        to: KNOWLEDGE_STATES.VALIDATED_KNOWLEDGE,
        reasons: ['passed review'],
        evidenceRefs: ['recall://evidence/review-1'],
      }, {
        actor: 'human-reviewer',
        humanApproved: true,
        now: '2026-05-05T00:00:00.000Z',
      });
      const demotion = appendKnowledgeTransitionRecord(ledgerPath, {
        artifactId: 'rule-1',
        from: KNOWLEDGE_STATES.VALIDATED_KNOWLEDGE,
        to: KNOWLEDGE_STATES.CONTRADICTED,
        reasons: ['new evidence conflicts'],
        falsifiers: ['benchmark regression reproduced'],
        evidenceRefs: ['recall://benchmark/regression-1'],
      }, {
        actor: 'adversarial-reviewer',
        now: '2026-05-05T00:05:00.000Z',
      });

      expect(demotion).toMatchObject({
        sequence: 2,
        event: {
          action: 'transition',
          from: 'validated_knowledge',
          to: 'contradicted',
          status: 'accepted',
        },
      });
      expect(historyForArtifact(ledgerPath, 'rule-1')).toHaveLength(2);
      expect(buildRollbackPlan(ledgerPath, 'rule-1', {
        now: '2026-05-05T00:10:00.000Z',
        targetState: KNOWLEDGE_STATES.REOPENED,
        reasons: ['rollback after contradiction'],
      })).toMatchObject({
        canRollback: true,
        currentState: 'contradicted',
        targetState: 'reopened',
        requiredAction: 'append_demotion_or_reopen_transition',
        historyCount: 2,
        suggestedTransition: {
          artifactId: 'rule-1',
          from: 'contradicted',
          to: 'reopened',
        },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('verification fails closed after tampering', () => {
    const { dir, ledgerPath } = tempLedger();
    try {
      appendKnowledgeTransitionRecord(ledgerPath, {
        artifactId: 'lesson-2',
        from: KNOWLEDGE_STATES.RAW_OBSERVATION,
        to: KNOWLEDGE_STATES.CANDIDATE_BELIEF,
        reasons: ['candidate staging'],
      });
      const records = readKnowledgeTransitionLedger(ledgerPath);
      records[0].event.to = KNOWLEDGE_STATES.VALIDATED_KNOWLEDGE;
      fs.writeFileSync(ledgerPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

      expect(verifyKnowledgeTransitionLedger(ledgerPath)).toMatchObject({
        ok: false,
        count: 1,
        errors: expect.arrayContaining([
          'record_hash_mismatch:1',
          'event_hash_mismatch:1',
        ]),
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
