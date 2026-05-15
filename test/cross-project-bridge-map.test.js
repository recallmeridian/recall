'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildCrossProjectBridgeMap,
  buildCrossProjectBridgeMapFromFile,
} = require('../lib/cross-project-bridge-map');

function event(overrides = {}) {
  return {
    schemaVersion: 'retrieval_reconsolidation_candidate/v1',
    eventType: 'retrieval_reconsolidation_candidate',
    eventId: overrides.eventId || `event-${Math.random()}`,
    retrievalDecision: overrides.retrievalDecision || 'allow',
    projectId: overrides.projectId || 'recall-dev',
    candidate: {
      id: overrides.candidateId || 'entry-1',
      projectId: overrides.projectId || 'recall-dev',
      sourceProjectId: overrides.sourceProjectId || 'research',
      partition: overrides.partition || 'trusted_kb',
      source_trust_level: overrides.sourceTrust || 'trusted',
    },
    observation: {
      retrieved: overrides.retrieved !== false,
    },
    proposedEffects: overrides.proposedEffects || ['observe_retrieval', 'cross_project_bridge_candidate'],
    policy: {
      effect: 'report_only',
      mayMutateMemory: false,
    },
  };
}

describe('Cross-Project Bridge Map', () => {
  test('summarizes cross-project retrieval candidates without promotion', () => {
    const report = buildCrossProjectBridgeMap({
      now: '2026-05-05T00:00:00.000Z',
      events: [
        event({ eventId: 'a', candidateId: 'r1' }),
        event({ eventId: 'b', candidateId: 'r2' }),
        event({
          eventId: 'c',
          candidateId: 'r3',
          sourceTrust: 'external_low',
          proposedEffects: ['observe_retrieval', 'candidate_review_signal', 'cross_project_bridge_candidate'],
        }),
        event({ eventId: 'same-project', sourceProjectId: 'recall-dev' }),
      ],
    });

    expect(report).toMatchObject({
      ok: true,
      status: 'warning',
      generatedAt: '2026-05-05T00:00:00.000Z',
      sourceEventCount: 4,
      ignoredEventCount: 1,
      bridgeCount: 1,
      promotionCandidateCount: 1,
      policy: {
        effect: 'report_only',
        mayMutateRetrieval: false,
        mayPromoteBridgeWeights: false,
        requiresHumanPromotion: true,
      },
    });
    expect(report.bridges[0]).toMatchObject({
      fromProject: 'research',
      toProject: 'recall-dev',
      retrievals: 3,
      allowedRetrievals: 3,
      trustedSignals: 2,
      lowTrustSignals: 1,
      candidateReviewSignals: 1,
      proposedWeight: 3.25,
      recommendation: 'review_for_bridge_promotion',
    });
  });

  test('keeps weak or denied bridges as observe-only evidence', () => {
    const report = buildCrossProjectBridgeMap({
      events: [
        event({
          eventId: 'denied',
          retrievalDecision: 'deny',
          retrieved: false,
          sourceTrust: 'external_low',
          proposedEffects: ['observe_retrieval', 'candidate_review_signal', 'cross_project_bridge_candidate'],
        }),
      ],
    });

    expect(report.status).toBe('healthy');
    expect(report.bridges[0]).toMatchObject({
      retrievals: 1,
      allowedRetrievals: 0,
      deniedRetrievals: 1,
      proposedWeight: -1.25,
      recommendation: 'do_not_promote',
    });
  });

  test('reads JSONL reconsolidation events from file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-map-'));
    try {
      const eventsPath = path.join(dir, 'events.jsonl');
      fs.writeFileSync(eventsPath, [
        JSON.stringify(event({ eventId: 'a' })),
        JSON.stringify(event({ eventId: 'b', projectId: 'sensitive-domain-project', sourceProjectId: 'recall-dev' })),
      ].join('\n'));

      const report = buildCrossProjectBridgeMapFromFile({
        eventsPath,
        now: '2026-05-05T00:00:00.000Z',
      });

      expect(report.sourceEventCount).toBe(2);
      expect(report.bridgeCount).toBe(2);
      expect(report.bridges.map((bridge) => `${bridge.fromProject}->${bridge.toProject}`)).toEqual([
        'recall-dev->sensitive-domain-project',
        'research->recall-dev',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reads hash-ledger wrapped reconsolidation events from file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-map-ledger-'));
    try {
      const eventsPath = path.join(dir, 'ledger.jsonl');
      fs.writeFileSync(eventsPath, [
        JSON.stringify({
          schemaVersion: 'retrieval_reconsolidation_ledger_record/v1',
          sequence: 1,
          previousHash: null,
          recordHash: 'not-verified-by-bridge-map',
          event: event({ eventId: 'ledger-a' }),
        }),
      ].join('\n'));

      const report = buildCrossProjectBridgeMapFromFile({
        eventsPath,
        now: '2026-05-05T00:00:00.000Z',
      });

      expect(report.sourceEventCount).toBe(1);
      expect(report.bridgeCount).toBe(1);
      expect(report.bridges[0]).toMatchObject({
        fromProject: 'research',
        toProject: 'recall-dev',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('warns and ignores malformed reconsolidation events', () => {
    const report = buildCrossProjectBridgeMap({
      events: [{ eventId: 'bad' }],
    });

    expect(report.ok).toBe(true);
    expect(report.status).toBe('warning');
    expect(report.warnings).toContain('malformed_reconsolidation_events_ignored');
    expect(report.malformedEvents).toEqual(['bad']);
  });
});
