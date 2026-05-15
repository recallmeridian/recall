'use strict';

const {
  formatSecurityDryRun,
  summarizeSecurityDryRun,
} = require('../lib/search-security-dry-run');

describe('GEO-SEC-033 search security dry run', () => {
  test('summarizes allowed, denied, and context treatment for normal search', () => {
    const summary = summarizeSecurityDryRun([
      {
        id: 'trusted-1',
        name: 'Trusted note',
        partition: 'trusted_kb',
        source_trust_level: 'trusted',
        text: 'trusted',
      },
      {
        id: 'candidate-1',
        name: 'Candidate note',
        partition: 'candidate_basin',
        source_trust_level: 'external_low',
        text: 'candidate',
      },
      {
        id: 'quarantine-1',
        name: 'Quarantine note',
        partition: 'quarantine_basin',
        source_trust_level: 'untrusted',
        text: 'hostile',
      },
    ], { from: 'normal' });

    expect(summary.allowed).toEqual([
      {
        id: 'trusted-1',
        name: 'Trusted note',
        partition: 'trusted_kb',
        source_trust_level: 'trusted',
        contextTreatment: 'trusted_raw',
      },
    ]);
    expect(summary.denied.map((item) => item.id)).toEqual(['candidate-1', 'quarantine-1']);
    expect(summary.denied[0].reasons).toContain('normal_retrieval_requires_trusted_partition');
    expect(summary.contextItems).toHaveLength(1);
    expect(summary.contextItems[0].context.kind).toBe('trusted_retrieval_data');
    expect(summary.reconsolidation.events).toHaveLength(3);
    expect(summary.reconsolidationSummary).toMatchObject({
      ok: true,
      byDecision: {
        allow: 1,
        deny: 2,
      },
      reportOnlyCount: 3,
    });
  });

  test('shows candidate content as Spotlighted when explicitly requested', () => {
    const summary = summarizeSecurityDryRun([
      {
        id: 'candidate-1',
        name: 'Candidate note',
        partition: 'candidate_basin',
        source_trust_level: 'external_low',
        text: 'external candidate',
      },
    ], { from: 'candidate' });

    expect(summary.allowed).toEqual([
      {
        id: 'candidate-1',
        name: 'Candidate note',
        partition: 'candidate_basin',
        source_trust_level: 'external_low',
        contextTreatment: 'spotlighted_untrusted_data',
      },
    ]);
    expect(summary.contextItems[0].context.kind).toBe('spotlighted_untrusted_data');
    expect(summary.contextItems[0].context.wrapped).toContain('<UNTRUSTED_DATA');
  });

  test('formats a human-readable dry-run report', () => {
    const report = formatSecurityDryRun({
      retrievalMode: '*',
      allowed: [
        {
          id: 'trusted-1',
          partition: 'trusted_kb',
          source_trust_level: 'trusted',
          contextTreatment: 'trusted_raw',
        },
      ],
      denied: [
        {
          id: 'quarantine-1',
          partition: 'quarantine_basin',
          source_trust_level: 'untrusted',
          reasons: ['from_star_excludes_quarantine'],
        },
      ],
    });

    expect(report).toContain('Security dry run (*)');
    expect(report).toContain('trusted-1 [trusted_kb/trusted] -> trusted_raw');
    expect(report).toContain('quarantine-1 [quarantine_basin/untrusted] -> from_star_excludes_quarantine');
  });
});
