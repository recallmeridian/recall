'use strict';

const {
  TEMPORAL_DECISIONS,
  VALID_TIME_SOURCES,
  buildSupersessionEvent,
  buildTimeline,
  filterEntriesAsOf,
  normalizeTemporalMetadata,
  temporalDecision,
  traceBlastRadius,
} = require('../lib/temporal-memory');

describe('temporal memory contract', () => {
  test('marks legacy valid_from as inferred from transaction time', () => {
    const temporal = normalizeTemporalMetadata({
      id: 'entry-legacy',
      projectId: 'recall-dev',
      addedAt: '2026-03-15T12:00:00.000Z',
      updatedAt: '2026-04-01T12:00:00.000Z',
    }, {
      now: '2026-05-07T00:00:00.000Z',
    });

    expect(temporal).toMatchObject({
      entryId: 'entry-legacy',
      valid_from: '2026-03-15T12:00:00.000Z',
      valid_to: null,
      valid_time_source: VALID_TIME_SOURCES.INFERRED_FROM_ADDED_AT,
      valid_time_confidence: 0.35,
      valid_time_inferred: true,
    });
    expect(temporal.transaction_time).toMatchObject({
      added_at: '2026-03-15T12:00:00.000Z',
      updated_at: '2026-04-01T12:00:00.000Z',
    });
  });

  test('supports as-of filtering with exclusive valid_to windows', () => {
    const entries = [
      {
        id: 'kelly-050',
        name: 'Kelly fraction 0.50',
        valid_from: '2026-03-01T00:00:00.000Z',
        valid_to: '2026-04-02T00:00:00.000Z',
      },
      {
        id: 'kelly-025',
        name: 'Kelly fraction 0.25',
        valid_from: '2026-04-02T00:00:00.000Z',
        valid_to: null,
      },
    ];

    const march = filterEntriesAsOf(entries, { asOf: '2026-03-20T00:00:00.000Z' });
    const aprilBoundary = filterEntriesAsOf(entries, { asOf: '2026-04-02T00:00:00.000Z' });

    expect(march.entries.map((entry) => entry.id)).toEqual(['kelly-050']);
    expect(aprilBoundary.entries.map((entry) => entry.id)).toEqual(['kelly-025']);
    expect(aprilBoundary.excluded.map((decision) => decision.temporal.entryId)).toContain('kelly-050');
  });

  test('abstains when valid time is inferred below required confidence', () => {
    const decision = temporalDecision({
      id: 'architecture-old',
      addedAt: '2026-03-25T00:00:00.000Z',
    }, {
      asOf: '2026-03-25T12:00:00.000Z',
      requireCertainValidTime: true,
    });

    expect(decision.decision).toBe(TEMPORAL_DECISIONS.UNKNOWN);
    expect(decision.abstain).toBe(true);
    expect(decision.reasons).toContain('valid_time_inferred_below_required_confidence');
  });

  test('builds supersession events without allowing silent overwrite', () => {
    const event = buildSupersessionEvent({
      id: 'config-json-canonical',
      valid_from: '2026-03-01T00:00:00.000Z',
    }, {
      id: 'kb-extraction-canonical',
      valid_from: '2026-04-10T00:00:00.000Z',
    }, {
      actor: 'research-cartographer',
      now: '2026-04-10T15:30:00.000Z',
      reason: 'Phase 0 hardening split canonical config storage.',
      evidenceRefs: ['repo:docs/phase-0-hardening.md'],
    });

    expect(event).toMatchObject({
      eventType: 'temporal_supersession',
      previousEntryId: 'config-json-canonical',
      nextEntryId: 'kb-extraction-canonical',
      valid_to: '2026-04-10T00:00:00.000Z',
      next_valid_from: '2026-04-10T00:00:00.000Z',
      policy: {
        closesPreviousValidityWindow: true,
        createsNewVersion: true,
        overwritesPreviousEntry: false,
      },
      errors: [],
    });
  });

  test('requires evidence before supersession becomes valid governance', () => {
    const event = buildSupersessionEvent({ id: 'old' }, { id: 'new' }, {
      now: '2026-05-07T00:00:00.000Z',
    });

    expect(event.errors).toContain('supersession_requires_evidence');
  });

  test('traces blast radius through temporally valid references', () => {
    const blast = traceBlastRadius('kelly-050', [
      {
        id: 'decision-1-used-kelly',
        sourceId: 'decision-1',
        targetId: 'kelly-050',
        relation: 'used_parameter',
        valid_from: '2026-03-10T00:00:00.000Z',
        valid_to: '2026-04-02T00:00:00.000Z',
      },
      {
        id: 'decision-2-used-kelly',
        sourceId: 'decision-2',
        targetId: 'kelly-050',
        relation: 'used_parameter',
        valid_from: '2026-04-15T00:00:00.000Z',
      },
    ], {
      asOf: '2026-03-20T00:00:00.000Z',
    });

    expect(blast.impactedCount).toBe(1);
    expect(blast.impacted[0]).toMatchObject({
      referenceId: 'decision-1-used-kelly',
      sourceId: 'decision-1',
      targetId: 'kelly-050',
      relation: 'used_parameter',
    });
  });

  test('builds version timelines from supersession links', () => {
    const timeline = buildTimeline([
      {
        id: 'kelly-050',
        name: 'Kelly fraction 0.50',
        valid_from: '2026-03-01T00:00:00.000Z',
        valid_to: '2026-04-02T00:00:00.000Z',
        superseded_by: ['kelly-025'],
      },
      {
        id: 'kelly-025',
        name: 'Kelly fraction 0.25',
        valid_from: '2026-04-02T00:00:00.000Z',
        supersedes: ['kelly-050'],
      },
      {
        id: 'unrelated',
        name: 'Unrelated memory',
        valid_from: '2026-01-01T00:00:00.000Z',
      },
    ], 'kelly-025');

    expect(timeline.foundTarget).toBe(true);
    expect(timeline.versionCount).toBe(2);
    expect(timeline.versions.map(({ entry }) => entry.id)).toEqual(['kelly-050', 'kelly-025']);
  });
});
