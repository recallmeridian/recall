'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  buildCoreFeatureCatalog,
  seedCoreFeatureRegistry,
} = require('../lib/core-feature-catalog');
const {
  listFeatureManifests,
  verifyFeatureRegistryChain,
} = require('../lib/feature-registry');

const root = path.join(__dirname, '..');
const bin = path.join(root, 'bin', 'meridian.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'core-feature-catalog-'));
}

function run(args, dataDir) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      MERIDIAN_DATA: dataDir,
    },
  });
}

describe('core feature catalog seed', () => {
  let dir;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('builds a validated catalog from curated manifests and built command surfaces', () => {
    const catalog = buildCoreFeatureCatalog(root, { bucket: 'all' });
    expect(catalog.length).toBeGreaterThanOrEqual(56);
    expect(catalog.map((manifest) => manifest.feature_id)).toEqual(expect.arrayContaining([
      'recall-project-health-brief',
      'knowledge-terrain-atlas',
      'recall-app-port',
      'welcome-doctor',
      'feature-seed-core-registry',
      'intelligence-cycle-run',
      'open-source-readiness',
      'release-mirror',
      'welcome-walkthrough',
    ]));
    expect(catalog.find((manifest) => manifest.feature_id === 'feature-register')).toMatchObject({
      risk_level: 'paper-write',
      human_approval_required_for: [
        { tool: 'recall.feature', action: 'feature:register' },
      ],
    });
  });

  test('defaults the seed catalog to audited open-source default features', () => {
    const defaults = buildCoreFeatureCatalog(root);
    const all = buildCoreFeatureCatalog(root, { bucket: 'all' });
    const bank = buildCoreFeatureCatalog(root, { bucket: 'feature_bank' });

    expect(defaults.length).toBeGreaterThanOrEqual(60);
    expect(all.length).toBe(defaults.length + bank.length);
    expect(defaults.map((manifest) => manifest.feature_id)).toEqual(expect.arrayContaining([
      'welcome-walkthrough',
      'recall-project-health-brief',
      'feature-build-plan',
      'open-source-readiness',
    ]));
    expect(defaults.map((manifest) => manifest.feature_id)).not.toEqual(expect.arrayContaining([
      'intelligence-cycle-run',
      'brainstorm-auto-session',
      'relay-configure',
      'recall-push',
      'feature-terrain-render',
    ]));
    expect(bank.map((manifest) => manifest.feature_id)).toEqual(expect.arrayContaining([
      'intelligence-cycle-run',
      'brainstorm-auto-session',
      'relay-configure',
      'recall-push',
      'feature-terrain-render',
    ]));
  });

  test('seeds the registry idempotently', () => {
    const registryPath = path.join(dir, 'registry.jsonl');
    const first = seedCoreFeatureRegistry({
      registryPath,
      root,
      now: '2026-05-08T00:00:00.000Z',
    });
    expect(first.ok).toBe(true);
    expect(first.bucket).toBe('default');
    expect(first.registered).toBeGreaterThanOrEqual(60);
    expect(first.unchanged).toBe(0);
    expect(verifyFeatureRegistryChain(registryPath)).toMatchObject({
      ok: true,
      count: first.registered,
    });

    const second = seedCoreFeatureRegistry({
      registryPath,
      root,
      now: '2026-05-08T00:01:00.000Z',
    });
    expect(second.ok).toBe(true);
    expect(second.registered).toBe(0);
    expect(second.unchanged).toBe(first.registered);
    expect(listFeatureManifests(registryPath)).toHaveLength(first.registered);
  });

  test('feature seed-core-registry command populates a clean local registry', () => {
    const seeded = run([
      'feature',
      'seed-core-registry',
      '--now',
      '2026-05-08T00:00:00.000Z',
      '--json',
    ], dir);
    expect(seeded.status).toBe(0);
    const body = JSON.parse(seeded.stdout);
    expect(body).toMatchObject({
      ok: true,
      unchanged: 0,
      invalid: [],
    });
    expect(body.bucket).toBe('default');
    expect(body.registered).toBeGreaterThanOrEqual(60);

    const health = run(['feature', 'health', '--json'], dir);
    expect(health.status).toBe(0);
    expect(JSON.parse(health.stdout)).toMatchObject({
      ok: true,
      status: 'healthy',
      counts: {
        invalid_manifests: 0,
        manifest_warnings: 0,
      },
    });
  });

  test('feature seed-core-registry can explicitly include the feature bank', () => {
    const seeded = run([
      'feature',
      'seed-core-registry',
      '--bucket',
      'all',
      '--now',
      '2026-05-08T00:00:00.000Z',
      '--json',
    ], dir);

    expect(seeded.status).toBe(0);
    const body = JSON.parse(seeded.stdout);
    expect(body.bucket).toBe('all');
    expect(body.registered).toBeGreaterThan(buildCoreFeatureCatalog(root).length);
    expect(listFeatureManifests(path.join(dir, 'feature-runs', 'recall-local', 'feature-registry.jsonl')).map((manifest) => manifest.feature_id)).toEqual(expect.arrayContaining([
      'intelligence-cycle-run',
      'brainstorm-auto-session',
      'relay-configure',
    ]));
  });
});
