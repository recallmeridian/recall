'use strict';

// open-source-readiness: allow-private-path-fixtures

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildProjectImportPlan,
  pathHasUnsafeActiveSource,
} = require('../lib/project-import-workflow');

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-import-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# Demo project\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo-project' }));
  return dir;
}

describe('safe outsider project import workflow', () => {
  test('builds a draft-only project import plan for a local project', () => {
    const dir = tempProject();
    try {
      const plan = buildProjectImportPlan({
        path: dir,
        stagingProject: 'recall-imports',
      }, {
        now: '2026-05-05T00:00:00.000Z',
      });

      expect(plan).toMatchObject({
        schemaVersion: 'project_import_plan/v1',
        ok: true,
        status: 'ready',
        stagingProject: 'recall-imports',
        safety: {
          importTrustState: 'draft',
          initialPartition: 'candidate_basin',
          automaticPromotionAllowed: false,
          requiredReviewBeforePromotion: true,
        },
      });
      expect(plan.detectedFiles).toEqual(expect.arrayContaining(['README.md', 'package.json']));
      expect(plan.commands.map((command) => command.id)).toEqual([
        'draft-import',
        'review-draft-reconstruction',
        'promotion-ledger-plan',
      ]);
      expect(plan.commands[0].command).not.toContain('--promote');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('blocks OneDrive and Downloads paths as active import sources', () => {
    expect(pathHasUnsafeActiveSource('C:\\Users\\jesse\\OneDrive\\project')).toBe(true);
    expect(pathHasUnsafeActiveSource('C:\\Users\\jesse\\Downloads\\project')).toBe(true);

    const plan = buildProjectImportPlan({
      path: 'C:\\Users\\jesse\\OneDrive\\project',
    }, {
      now: '2026-05-05T00:00:00.000Z',
    });

    expect(plan.ok).toBe(false);
    expect(plan.status).toBe('blocked');
    expect(plan.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'project-path-needs-localization', severity: 'blocker' }),
    ]));
    expect(plan.commands).toEqual([]);
  });

  test('warns when project context is weak but still keeps import draft-only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-import-empty-'));
    try {
      const plan = buildProjectImportPlan({ path: dir });

      expect(plan.ok).toBe(true);
      expect(plan.status).toBe('ready_with_warnings');
      expect(plan.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'weak-project-context', severity: 'warn' }),
      ]));
      expect(plan.safety.automaticPromotionAllowed).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
