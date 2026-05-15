'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DEATH_GRIP_ACTIONS,
  buildMemoryEcosystemHealthReport,
  buildMemoryEcosystemHealthReportFromFiles,
  classifyDeathGripAction,
} = require('../lib/memory-ecosystem-health');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-ecosystem-health-'));
}

describe('Memory Ecosystem Health Report', () => {
  test('reports healthy when trusted memory and feature behavior are quiet', () => {
    const report = buildMemoryEcosystemHealthReport({
      now: '2026-05-05T00:00:00.000Z',
      entries: [
        {
          id: 'trusted-1',
          partition: 'trusted_kb',
          source_trust_level: 'trusted',
          status: 'active',
          source_type: 'manual_note',
        },
      ],
      securityEvents: [],
      featureRuns: [
        {
          run_id: 'run-1',
          status: 'allowed',
          tool: 'notes.search',
          action: 'notes.search',
          input_origins: [{ partition: 'trusted_kb', source_trust_level: 'trusted' }],
        },
      ],
      approvals: [],
    });

    expect(report).toMatchObject({
      ok: true,
      status: 'healthy',
      feverMode: {
        level: 'normal',
        score: 0,
      },
      entries: {
        total: 1,
        partitions: { trusted_kb: 1 },
      },
      behavior: {
        totalRuns: 1,
        byStatus: { allowed: 1 },
      },
    });
    expect(report.researchGrounding).toContain('behavioral-immune-layer-ai-defense-2026');
  });

  test('surfaces containment failures when untrusted memory appears in trusted KB', () => {
    const report = buildMemoryEcosystemHealthReport({
      entries: [
        {
          id: 'bad-trust',
          partition: 'trusted_kb',
          source_trust_level: 'external_low',
          status: 'active',
          source_type: 'external_pdf',
        },
        {
          id: 'auto-promoted',
          partition: 'candidate_basin',
          source_trust_level: 'external_low',
          status: 'promoted',
        },
      ],
      securityEvents: [],
      featureRuns: [],
      approvals: [],
    });

    expect(report.ok).toBe(false);
    expect(report.status).toBe('needs_attention');
    expect(report.errors).toEqual(expect.arrayContaining([
      'untrusted_content_in_trusted_kb',
      'invalid_promotion_state',
    ]));
    expect(report.entries.risks.untrustedInTrusted).toEqual(['bad-trust']);
    expect(report.entries.risks.autoPromotionRisks).toEqual(['auto-promoted']);
  });

  test('classifies death-grip action pressure and raises fever mode without enforcing it', () => {
    const report = buildMemoryEcosystemHealthReport({
      entries: [],
      securityEvents: [
        {
          id: 'event-1',
          eventType: 'feature_execution_gate',
          action: 'database:export',
          policyResult: 'deny',
          reasons: ['untrusted_origin_to_high_risk_sink'],
        },
        {
          id: 'event-2',
          eventType: 'feature_execution_gate',
          action: 'promote:quarantine',
          policyResult: 'deny',
          reasons: ['hard_blocked_origin_to_high_risk_sink'],
          partition: 'quarantine_basin',
        },
      ],
      featureRuns: [
        {
          run_id: 'run-1',
          status: 'blocked',
          tool: 'exporter',
          action: 'database:export',
          policy_reasons: ['untrusted_origin_to_high_risk_sink'],
          input_origins: [{ partition: 'candidate_basin', source_trust_level: 'external_low' }],
        },
        {
          run_id: 'run-2',
          status: 'approval_required',
          tool: 'email',
          action: 'email:external',
          input_origins: [{ partition: 'sensitive_vault', source_trust_level: 'sensitive' }],
        },
      ],
      approvals: [{ id: 'approval-1', status: 'pending' }],
    });

    expect(report.ok).toBe(true);
    expect(report.status).toBe('warning');
    expect(report.security.deathGripAttempts).toMatchObject({
      export: 1,
      promote_quarantine: 1,
    });
    expect(report.behavior.deathGripAttempts).toMatchObject({
      export: 1,
      external_write: 1,
    });
    expect(report.feverMode.level).toBe('high_friction');
    expect(report.feverMode.recommendedFriction).toEqual(expect.arrayContaining([
      'require_human_approval_for_death_grip_actions',
      'limit_exports',
    ]));
  });

  test('reads entries, audit events, feature runs, and approvals from local files', () => {
    const dir = tempDir();
    try {
      const entriesPath = path.join(dir, 'entries.jsonl');
      const auditPath = path.join(dir, 'audit.jsonl');
      const runPath = path.join(dir, 'runs.jsonl');
      const approvalPath = path.join(dir, 'approvals.jsonl');
      fs.writeFileSync(entriesPath, `${JSON.stringify({
        id: 'candidate-1',
        partition: 'candidate_basin',
        source_trust_level: 'external_low',
        status: 'draft',
      })}\n`);
      fs.writeFileSync(auditPath, `${JSON.stringify({
        id: 'audit-1',
        eventType: 'quarantine_classification',
        policyResult: 'quarantine',
        partition: 'quarantine_basin',
      })}\n`);
      fs.writeFileSync(runPath, `${JSON.stringify({
        run_id: 'run-1',
        status: 'allowed',
        tool: 'notes.search',
        action: 'notes.search',
      })}\n`);
      fs.writeFileSync(approvalPath, '');

      const report = buildMemoryEcosystemHealthReportFromFiles({
        projectId: 'recall-local',
        now: '2026-05-05T00:00:00.000Z',
        entriesPath,
        auditPath,
        runPath,
        approvalPath,
      });

      expect(report.projectId).toBe('recall-local');
      expect(report.generatedAt).toBe('2026-05-05T00:00:00.000Z');
      expect(report.entries.total).toBe(1);
      expect(report.security.counts.quarantineEvents).toBe(1);
      expect(report.status).toBe('warning');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps death-grip taxonomy explicit and reusable', () => {
    expect(classifyDeathGripAction('delete:anything')).toBe(DEATH_GRIP_ACTIONS.DELETE);
    expect(classifyDeathGripAction('email:external')).toBe(DEATH_GRIP_ACTIONS.EXTERNAL_WRITE);
    expect(classifyDeathGripAction('promote:quarantine')).toBe(DEATH_GRIP_ACTIONS.PROMOTE_QUARANTINE);
    expect(classifyDeathGripAction('notes.search')).toBe('');
  });
});
