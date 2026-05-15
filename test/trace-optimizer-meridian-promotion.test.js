'use strict';

const {
  DEFAULT_MIN_CONFIDENCE,
  evaluatePromotionGate,
  buildLessonPayload,
  promoteToKB,
} = require('../lib/trace-optimizer/meridian-promotion');

function fullyPipelinedBasin(overrides = {}) {
  return {
    id: 'basin-test',
    pattern: 'sandbox eperm',
    count: 4,
    agents: ['implementation-builder'],
    taskTypes: ['implementation'],
    projects: ['recall-dev'],
    sampleHandoffIds: ['h1', 'h2', 'h3', 'h4'],
    rawSamples: ['Sandbox EPERM'],
    reflection: {
      rootCause: 'sandbox blocks child node.exe spawn',
      contributingFactors: ['workspace.write approval not granted'],
      recommendedNextActions: ['surface approval-path issue, not install failure'],
      confidence: 0.85,
      model: 'mock-model',
      parseFailed: false,
    },
    recommendation: {
      patchKind: 'doc_edit',
      target: { file: 'AGENTS.md', section: 'Sandbox', locator: null },
      change: { before: '', after: 'When sandbox EPERM appears, treat as approval-path issue.', diffSummary: 'Add sandbox EPERM guidance' },
      rationale: 'Tells agents to escalate approval rather than blame install.',
      estimatedImpact: 'medium',
      riskNotes: [],
      confidence: 0.8,
      parseFailed: false,
    },
    verification: {
      status: 'applied',
      applied: true,
      syntaxValid: null, // doc_edit, no syntax check
      targetFile: 'AGENTS.md',
      tempCopy: '/tmp/trace-verify-x-AGENTS.md',
      notes: ['Additive patch: appended change.after to end of target'],
      testsRun: null,
      verifiedAt: '2026-05-12T20:00:00.000Z',
    },
    ...overrides,
  };
}

describe('meridian-promotion / evaluatePromotionGate', () => {
  test('fully-pipelined basin passes', () => {
    const gate = evaluatePromotionGate(fullyPipelinedBasin());
    expect(gate.ok).toBe(true);
    expect(gate.reasons).toEqual([]);
  });

  test('missing recommendation fails', () => {
    const gate = evaluatePromotionGate(fullyPipelinedBasin({ recommendation: null }));
    expect(gate.ok).toBe(false);
    expect(gate.reasons).toContain('no_recommendation');
  });

  test('parseFailed recommendation fails', () => {
    const gate = evaluatePromotionGate(fullyPipelinedBasin({
      recommendation: { ...fullyPipelinedBasin().recommendation, parseFailed: true },
    }));
    expect(gate.ok).toBe(false);
    expect(gate.reasons).toContain('recommendation_parse_failed');
  });

  test('low-confidence recommendation fails (under 0.6 default)', () => {
    const gate = evaluatePromotionGate(fullyPipelinedBasin({
      recommendation: { ...fullyPipelinedBasin().recommendation, confidence: 0.4 },
    }));
    expect(gate.ok).toBe(false);
    expect(gate.reasons.some((r) => r.startsWith('recommendation_confidence_below'))).toBe(true);
  });

  test('custom minConfidence is respected', () => {
    const gate = evaluatePromotionGate(fullyPipelinedBasin(), { minConfidence: 0.9 });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.some((r) => r.includes('0.9'))).toBe(true);
  });

  test('missing verification fails', () => {
    const gate = evaluatePromotionGate(fullyPipelinedBasin({ verification: null }));
    expect(gate.ok).toBe(false);
    expect(gate.reasons).toContain('no_verification');
  });

  test('verification status not applied fails', () => {
    const gate = evaluatePromotionGate(fullyPipelinedBasin({
      verification: { ...fullyPipelinedBasin().verification, status: 'before_not_found' },
    }));
    expect(gate.ok).toBe(false);
    expect(gate.reasons).toContain('verification_status_before_not_found');
  });

  test('syntaxValid=false fails', () => {
    const gate = evaluatePromotionGate(fullyPipelinedBasin({
      verification: { ...fullyPipelinedBasin().verification, syntaxValid: false },
    }));
    expect(gate.ok).toBe(false);
    expect(gate.reasons).toContain('syntax_invalid');
  });

  test('syntaxValid=null (doc_edit) passes', () => {
    const gate = evaluatePromotionGate(fullyPipelinedBasin({
      verification: { ...fullyPipelinedBasin().verification, syntaxValid: null },
    }));
    expect(gate.ok).toBe(true);
  });

  test('multiple failures accumulate in reasons array', () => {
    const gate = evaluatePromotionGate(fullyPipelinedBasin({
      recommendation: { ...fullyPipelinedBasin().recommendation, confidence: 0.1, parseFailed: true },
      verification: { ...fullyPipelinedBasin().verification, status: 'before_not_found', syntaxValid: false },
    }));
    expect(gate.ok).toBe(false);
    expect(gate.reasons.length).toBeGreaterThanOrEqual(3);
  });
});

describe('meridian-promotion / buildLessonPayload', () => {
  test('produces a recall_kb-compatible entry payload', () => {
    const payload = buildLessonPayload(fullyPipelinedBasin());
    expect(payload.project).toBe('recall-dev');
    expect(payload.entry.category).toBe('lessons');
    expect(payload.entry.status).toBe('active');
    expect(payload.entry.name).toContain('Trace Optimizer');
    expect(payload.entry.name).toContain('sandbox eperm');
    expect(payload.entry.name).toContain('doc_edit');
    expect(payload.entry.description).toContain('Failure pattern');
    expect(payload.entry.description).toContain('Root cause');
    expect(payload.entry.description).toContain('Recommended patch');
    expect(payload.entry.description).toContain('Verification');
    expect(payload.entry.sourceBasinId).toBe('basin-test');
    expect(payload.entry.patchKind).toBe('doc_edit');
    expect(payload.entry.provenance.author_type).toBe('trace-optimizer-slice-4-promoted');
    expect(payload.entry.provenance.sourceBasinId).toBe('basin-test');
  });

  test('falls back to recall-dev when basin has no projects', () => {
    const payload = buildLessonPayload(fullyPipelinedBasin({ projects: [] }));
    expect(payload.project).toBe('recall-dev');
  });

  test('falls back to opts.project when basin has no projects and opts provided', () => {
    const payload = buildLessonPayload(fullyPipelinedBasin({ projects: [] }), { project: 'sample-bot-project' });
    expect(payload.project).toBe('sample-bot-project');
  });

  test('truncates a very long pattern in the entry name', () => {
    const long = 'x'.repeat(200);
    const payload = buildLessonPayload(fullyPipelinedBasin({ pattern: long }));
    expect(payload.entry.name.length).toBeLessThanOrEqual(150);
    expect(payload.entry.name).toContain('…');
  });
});

describe('meridian-promotion / promoteToKB', () => {
  test('rejects when gate fails', () => {
    const result = promoteToKB(fullyPipelinedBasin({ recommendation: null }), {
      addEntry: () => { throw new Error('should not be called'); },
    });
    expect(result.promoted).toBe(false);
    expect(result.reason).toMatch(/gate_failed/);
    expect(result.entry).toBeUndefined();
  });

  test('dry-run skips kb.addEntry even when gate passes', () => {
    let called = false;
    const result = promoteToKB(fullyPipelinedBasin(), {
      addEntry: () => { called = true; return {}; },
    }, { dryRun: true });
    expect(called).toBe(false);
    expect(result.promoted).toBe(false);
    expect(result.reason).toBe('dry_run');
    expect(result.payload).toBeDefined();
  });

  test('calls kb.addEntry with project + entry when gate passes', () => {
    let captured;
    const kb = {
      addEntry: (project, entry) => {
        captured = { project, entry };
        return { id: 'kb-id-123', name: entry.name, category: entry.category };
      },
    };
    const result = promoteToKB(fullyPipelinedBasin(), kb);
    expect(result.promoted).toBe(true);
    expect(result.entry.id).toBe('kb-id-123');
    expect(captured.project).toBe('recall-dev');
    expect(captured.entry.category).toBe('lessons');
    expect(captured.entry.provenance.author_type).toBe('trace-optimizer-slice-4-promoted');
  });

  test('returns kb_unavailable when kb missing or invalid', () => {
    const r1 = promoteToKB(fullyPipelinedBasin(), null);
    expect(r1.promoted).toBe(false);
    expect(r1.reason).toBe('kb_unavailable');
    const r2 = promoteToKB(fullyPipelinedBasin(), {});
    expect(r2.promoted).toBe(false);
    expect(r2.reason).toBe('kb_unavailable');
  });

  test('returns kb_addEntry_failed when kb.addEntry throws', () => {
    const kb = { addEntry: () => { throw new Error('disk full'); } };
    const result = promoteToKB(fullyPipelinedBasin(), kb);
    expect(result.promoted).toBe(false);
    expect(result.reason).toMatch(/kb_addEntry_failed.*disk full/);
  });

  test('default minConfidence matches exported constant', () => {
    expect(DEFAULT_MIN_CONFIDENCE).toBe(0.6);
  });
});
