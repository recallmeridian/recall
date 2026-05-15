'use strict';

// open-source-readiness: allow-private-path-fixtures

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const meridian = require('../lib/meridian-core');

const welcome = require('../lib/welcome');
const historyImport = require('../lib/history-import');

const bin = path.join(__dirname, '..', 'bin', 'meridian.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recall-welcome-'));
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      MERIDIAN_DATA: options.dataDir || tempDir(),
    },
  });
}

describe('welcome orchestration', () => {
  let dir;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('doctor reports a writable local setup and local tool resolution', () => {
    const dataDir = path.join(dir, 'data');
    const report = welcome.buildWelcomeDoctor({
      cwd: dir,
      dataDir,
      expectedToolBin: path.join(dir, 'tools', 'bin'),
      commandResolver(name) {
        return [path.join(dir, 'tools', 'bin', process.platform === 'win32' ? `${name}.exe` : name)];
      },
      now: '2026-05-05T00:00:00.000Z',
    });

    expect(report.status).toBe('ready');
    expect(report.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
      'workspace-local',
      'data-dir-writable',
      'tool-rg-local',
      'tool-git-local',
    ]));
  });

  test('doctor blocks unsafe workspace and data directory paths', () => {
    const report = welcome.buildWelcomeDoctor({
      cwd: 'C:\\Users\\jesse\\OneDrive\\recall-cli',
      dataDir: 'C:\\Users\\jesse\\Downloads\\recall-data',
      commandResolver() {
        return [];
      },
    });

    expect(report.status).toBe('blocked');
    expect(report.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
      'workspace-needs-localization',
      'data-dir-needs-localization',
    ]));
  });

  test('discovery finds git projects and known AI session source folders', () => {
    const project = path.join(dir, 'projects', 'alpha');
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.codex', 'sessions'), { recursive: true });

    const report = welcome.buildWelcomeDiscovery({
      roots: [dir],
      maxDepth: 3,
      now: '2026-05-05T00:00:00.000Z',
    });

    expect(report.status).toBe('found_sources');
    expect(report.projects.map((item) => item.path)).toContain(project);
    expect(report.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'codex', kind: 'directory' }),
    ]));
    expect(report.adapters.some((adapter) => adapter.source === 'gemini-cli' && adapter.status === 'adapter-needed')).toBe(true);
  });

  test('project plan preserves draft-only import safety and next action search', () => {
    fs.writeFileSync(path.join(dir, 'README.md'), '# Alpha\n');

    const report = welcome.buildWelcomeProjectPlan(dir, {
      project: 'recall-imports',
      now: '2026-05-05T00:00:00.000Z',
    });

    expect(report.status).toBe('ready');
    expect(report.plan.safety).toMatchObject({
      importTrustState: 'draft',
      initialPartition: 'candidate_basin',
      automaticPromotionAllowed: false,
    });
    expect(report.nextSteps.map((step) => step.id)).toEqual([
      'run-draft-import',
      'review-reconstruction',
      'ask-recall-next-actions',
    ]);
    expect(report.nextSteps[0].command).not.toContain('--promote');
  });

  test('review summarizes draft project reconstructions with review commands', () => {
    const kb = meridian.init(dir);
    const records = [
      historyImport.normalizeRecord({
        source: 'codex',
        kind: 'coding_session',
        sourcePath: path.join(dir, 'session.jsonl'),
        title: 'Alpha session',
        text: 'Decision: use the import review gate. TODO fix the onboarding docs.',
        projectHint: 'alpha',
      }),
      historyImport.normalizeRecord({
        source: 'repo',
        kind: 'repository_snapshot',
        sourcePath: dir,
        title: 'Alpha repo',
        text: 'Alpha README and package context.',
        projectHint: 'alpha',
      }),
    ];
    historyImport.importRecords(kb, historyImport.DEFAULT_PROJECT, records);
    historyImport.analyzeProject(kb, historyImport.DEFAULT_PROJECT);

    const report = welcome.buildWelcomeReview(kb, {
      project: historyImport.DEFAULT_PROJECT,
      now: '2026-05-05T00:00:00.000Z',
    });
    kb.close();

    expect(report.status).toBe('ready_for_review');
    expect(report.reconstructions).toEqual([
      expect.objectContaining({
        id: 'analysis-alpha',
        projectKey: 'alpha',
        evidenceCount: 2,
        recommendation: expect.stringContaining('Ready for human review'),
        reviewCommands: expect.objectContaining({
          promoteAfterReview: 'recall import-history promote analysis-alpha',
        }),
      }),
    ]);
  });

  test('actions propose non-automated next steps from reconstruction evidence', () => {
    const kb = meridian.init(dir);
    const records = [
      historyImport.normalizeRecord({
        source: 'codex',
        kind: 'coding_session',
        sourcePath: path.join(dir, 'session.jsonl'),
        title: 'Beta session',
        text: 'Decision: choose draft imports. TODO fix blocked setup path.',
        projectHint: 'beta',
      }),
    ];
    historyImport.importRecords(kb, historyImport.DEFAULT_PROJECT, records);
    historyImport.analyzeProject(kb, historyImport.DEFAULT_PROJECT);

    const report = welcome.buildWelcomeActions(kb, {
      project: historyImport.DEFAULT_PROJECT,
      now: '2026-05-05T00:00:00.000Z',
    });
    kb.close();

    expect(report.status).toBe('proposed_actions');
    expect(report.automationAllowed).toBe(false);
    expect(report.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'review_project_identity',
        automationAllowed: false,
      }),
      expect.objectContaining({
        kind: 'resolve_blockers',
        priority: 'high',
        sampleEvidence: expect.arrayContaining([
          expect.stringContaining('TODO fix blocked setup path'),
        ]),
      }),
      expect.objectContaining({
        kind: 'import_more_context',
      }),
    ]));
  });

  test('organization packet validates and applies rename, defer, and promote decisions', () => {
    const kb = meridian.init(dir);
    const records = [
      historyImport.normalizeRecord({
        source: 'codex',
        kind: 'coding_session',
        sourcePath: path.join(dir, 'alpha.jsonl'),
        title: 'Alpha session',
        text: 'Decision: keep the import gate. TODO add welcome organize.',
        projectHint: 'alpha',
      }),
      historyImport.normalizeRecord({
        source: 'repo',
        kind: 'repository_snapshot',
        sourcePath: dir,
        title: 'Alpha repo',
        text: 'Alpha README.',
        projectHint: 'alpha',
      }),
      historyImport.normalizeRecord({
        source: 'codex',
        kind: 'coding_session',
        sourcePath: path.join(dir, 'beta.jsonl'),
        title: 'Beta session',
        text: 'TODO needs another export before trusting this.',
        projectHint: 'beta',
      }),
      historyImport.normalizeRecord({
        source: 'codex',
        kind: 'coding_session',
        sourcePath: path.join(dir, 'gamma.jsonl'),
        title: 'Gamma session',
        text: 'Decision: promote after human review.',
        projectHint: 'gamma',
      }),
      historyImport.normalizeRecord({
        source: 'repo',
        kind: 'repository_snapshot',
        sourcePath: dir,
        title: 'Gamma repo',
        text: 'Gamma README.',
        projectHint: 'gamma',
      }),
    ];
    historyImport.importRecords(kb, historyImport.DEFAULT_PROJECT, records);
    historyImport.analyzeProject(kb, historyImport.DEFAULT_PROJECT);

    const packet = welcome.buildWelcomeOrganizationPacket(kb, {
      project: historyImport.DEFAULT_PROJECT,
      now: '2026-05-05T00:00:00.000Z',
    });
    packet.decisions = packet.decisions.map((decision) => {
      if (decision.reconstructionId === 'analysis-alpha') {
        return {
          ...decision,
          decision: 'rename',
          newProjectName: 'Alpha Product',
          notes: 'User confirmed project name.',
        };
      }
      if (decision.reconstructionId === 'analysis-beta') {
        return {
          ...decision,
          decision: 'defer',
          notes: 'Evidence is too thin.',
        };
      }
      if (decision.reconstructionId === 'analysis-gamma') {
        return {
          ...decision,
          decision: 'promote',
          reviewConfirmed: true,
        };
      }
      return decision;
    });

    expect(welcome.validateWelcomeOrganizationPacket(packet)).toMatchObject({
      ok: true,
      issues: [],
    });

    const report = welcome.applyWelcomeOrganizationPacket(kb, packet, {
      now: '2026-05-05T00:00:00.000Z',
    });
    const alpha = kb.getEntry(historyImport.DEFAULT_PROJECT, 'analysis-alpha');
    const beta = kb.getEntry(historyImport.DEFAULT_PROJECT, 'analysis-beta');
    const gamma = kb.getEntry(historyImport.DEFAULT_PROJECT, 'analysis-gamma');
    kb.close();

    expect(report).toMatchObject({
      status: 'applied',
      appliedCount: 3,
    });
    expect(alpha.name).toBe('Project reconstruction: Alpha Product');
    expect(alpha._extensions.summary.projectName).toBe('Alpha Product');
    expect(alpha._extensions.welcomeOrganization.decision).toBe('rename');
    expect(beta._extensions.promotionState).toBe('deferred');
    expect(gamma.status).toBe('active');
    expect(gamma._extensions.promotionState).toBe('promoted');
  });

  test('organization packet blocks promotion without explicit review confirmation', () => {
    const packet = {
      schemaVersion: welcome.ORGANIZATION_PACKET_SCHEMA,
      project: historyImport.DEFAULT_PROJECT,
      decisions: [
        {
          reconstructionId: 'analysis-alpha',
          decision: 'promote',
          reviewConfirmed: false,
        },
      ],
    };

    expect(welcome.validateWelcomeOrganizationPacket(packet)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        'decisions[0].promote_requires_review_confirmed',
      ]),
    });
  });
});

describe('welcome command', () => {
  let dir;

  beforeEach(() => {
    dir = tempDir();
    fs.writeFileSync(path.join(dir, 'README.md'), '# Alpha\n');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('prints project plan JSON', () => {
    const result = run(['welcome', 'plan', dir, '--json'], {
      dataDir: path.join(dir, 'data'),
    });

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.kind).toBe('project-plan');
    expect(report.plan.ok).toBe(true);
    expect(report.nextSteps[0].command).toContain('import-history upload-project');
  });

  test('exits nonzero for unsafe project paths', () => {
    const result = run(['welcome', 'plan', 'C:\\Users\\jesse\\Downloads\\project', '--json'], {
      dataDir: path.join(dir, 'data'),
    });

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.plan.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'project-path-needs-localization' }),
    ]));
  });

  test('prints review and action JSON from imported draft reconstructions', () => {
    const dataDir = path.join(dir, 'data');
    const kb = meridian.init(dataDir);
    const records = [
      historyImport.normalizeRecord({
        source: 'codex',
        kind: 'coding_session',
        sourcePath: path.join(dir, 'session.jsonl'),
        title: 'Gamma session',
        text: 'Decision: ship welcome review. TODO add action cards.',
        projectHint: 'gamma',
      }),
    ];
    historyImport.importRecords(kb, historyImport.DEFAULT_PROJECT, records);
    historyImport.analyzeProject(kb, historyImport.DEFAULT_PROJECT);
    kb.close();

    const review = run(['welcome', 'review', '--json'], { dataDir });
    const actions = run(['welcome', 'actions', '--json'], { dataDir });

    expect(review.status).toBe(0);
    expect(actions.status).toBe(0);
    expect(JSON.parse(review.stdout)).toMatchObject({
      kind: 'review',
      status: 'ready_for_review',
    });
    expect(JSON.parse(actions.stdout)).toMatchObject({
      kind: 'actions',
      status: 'proposed_actions',
      automationAllowed: false,
    });
  });

  test('prints, checks, and applies organization packets', () => {
    const dataDir = path.join(dir, 'data');
    const kb = meridian.init(dataDir);
    const records = [
      historyImport.normalizeRecord({
        source: 'codex',
        kind: 'coding_session',
        sourcePath: path.join(dir, 'session.jsonl'),
        title: 'Delta session',
        text: 'Decision: rename after review. TODO verify the name.',
        projectHint: 'delta',
      }),
      historyImport.normalizeRecord({
        source: 'repo',
        kind: 'repository_snapshot',
        sourcePath: dir,
        title: 'Delta repo',
        text: 'Delta README.',
        projectHint: 'delta',
      }),
    ];
    historyImport.importRecords(kb, historyImport.DEFAULT_PROJECT, records);
    historyImport.analyzeProject(kb, historyImport.DEFAULT_PROJECT);
    kb.close();

    const packetResult = run(['welcome', 'organize', '--json'], { dataDir });
    expect(packetResult.status).toBe(0);
    const packet = JSON.parse(packetResult.stdout);
    packet.decisions[0].decision = 'rename';
    packet.decisions[0].newProjectName = 'Delta Workspace';
    const packetPath = path.join(dir, 'organize.json');
    fs.writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`);

    const check = run(['welcome', 'organize-check', packetPath, '--json'], { dataDir });
    const apply = run(['welcome', 'organize-apply', packetPath, '--json'], { dataDir });
    const nextKb = meridian.init(dataDir);
    const updated = nextKb.getEntry(historyImport.DEFAULT_PROJECT, 'analysis-delta');
    nextKb.close();

    expect(check.status).toBe(0);
    expect(JSON.parse(check.stdout)).toMatchObject({ ok: true });
    expect(apply.status).toBe(0);
    expect(JSON.parse(apply.stdout)).toMatchObject({
      kind: 'organize-apply',
      status: 'applied',
      appliedCount: 1,
    });
    expect(updated.name).toBe('Project reconstruction: Delta Workspace');
  });

  test('writes standard first-run walkthrough packet', () => {
    const outputDir = path.join(dir, 'first-run-packet');
    const result = run([
      'welcome',
      'walkthrough',
      '--participant-id',
      'first-run',
      '--output-dir',
      outputDir,
      '--json',
    ], {
      dataDir: path.join(dir, 'data'),
    });

    expect(result.status).toBe(0);
    const packet = JSON.parse(result.stdout);
    expect(packet.ok).toBe(true);
    expect(packet.outsiderId).toBe('first-run');
    expect(packet.files.readme).toBe(path.join(outputDir, 'README.md'));
    expect(packet.readme).toContain('Recall First-Run Walkthrough Packet');
    expect(fs.existsSync(path.join(outputDir, 'README.md'))).toBe(true);
  });
});
