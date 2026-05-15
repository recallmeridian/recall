'use strict';

const {
  RECONSOLIDATION_SCHEMA,
  buildRetrievalReconsolidationBatch,
  buildRetrievalReconsolidationEvent,
  consumeRetrievalReconsolidationCandidates,
} = require('../lib/retrieval-reconsolidation');

describe('retrieval reconsolidation candidates', () => {
  test('emits a report-only reconsolidation candidate without raw query text', () => {
    const event = buildRetrievalReconsolidationEvent({
      generatedAt: '2026-05-05T00:00:00.000Z',
      queryContext: {
        projectId: 'recall-dev',
        query: 'sensitive private user question',
        from: 'normal',
      },
      rank: 1,
      candidate: {
        id: 'trusted-1',
        projectId: 'recall-dev',
        source_project_id: 'research',
        partition: 'trusted_kb',
        source_trust_level: 'trusted',
        status: 'active',
        _relevanceScore: 0.9,
      },
    });

    expect(event).toMatchObject({
      schemaVersion: RECONSOLIDATION_SCHEMA,
      eventType: 'retrieval_reconsolidation_candidate',
      projectId: 'recall-dev',
      retrievalMode: 'normal',
      retrievalDecision: 'allow',
      rank: 1,
      candidate: {
        id: 'trusted-1',
        partition: 'trusted_kb',
        sourceProjectId: 'research',
        source_trust_level: 'trusted',
        lifecycle: 'active',
        scores: {
          relevanceScore: 0.9,
        },
      },
      observation: {
        retrieved: true,
      },
      policy: {
        effect: 'report_only',
        mayMutateMemory: false,
        mayChangeRanking: false,
        requiresPromotionBeforeMutation: true,
      },
    });
    expect(event.query.queryHash).toMatch(/^sha256:/);
    expect(JSON.stringify(event)).not.toContain('sensitive private user question');
    expect(event.proposedEffects).toEqual(expect.arrayContaining([
      'observe_retrieval',
      'candidate_retrieval_count_increment',
      'candidate_last_retrieved_at_update',
    ]));
  });

  test('batches allowed and denied retrieval decisions for a stub consumer', () => {
    const batch = buildRetrievalReconsolidationBatch({
      generatedAt: '2026-05-05T00:00:00.000Z',
      queryContext: {
        projectId: 'recall-dev',
        query: 'quarantine test',
        from: 'normal',
      },
      allowed: [
        {
          id: 'trusted-1',
          projectId: 'recall-dev',
          partition: 'trusted_kb',
          source_trust_level: 'trusted',
        },
      ],
      denied: [
        {
          candidate: {
            id: 'quarantine-1',
            projectId: 'recall-dev',
            partition: 'quarantine_basin',
            source_trust_level: 'untrusted',
          },
          reasons: ['normal_retrieval_requires_trusted_partition'],
        },
      ],
    });

    const summary = consumeRetrievalReconsolidationCandidates(batch.events);

    expect(batch.events).toHaveLength(2);
    expect(summary).toMatchObject({
      ok: true,
      eventCount: 2,
      parseableCount: 2,
      reportOnlyCount: 2,
      byPartition: {
        trusted_kb: 1,
        quarantine_basin: 1,
      },
      byDecision: {
        allow: 1,
        deny: 1,
      },
    });
    expect(summary.proposedEffects.candidate_review_signal).toBe(1);
  });

  test('consumer fails closed on malformed events', () => {
    const summary = consumeRetrievalReconsolidationCandidates([
      { eventType: 'retrieval_reconsolidation_candidate' },
    ]);

    expect(summary.ok).toBe(false);
    expect(summary.errors).toEqual(['invalid_event:1']);
  });
});
