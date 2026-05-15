'use strict';

const { buildSbom, verifyLockfile, auditDependencyShapes } = require('../lib/security/supply-chain');

const samplePackageJson = {
  name: '@example/cli',
  version: '1.0.0',
  dependencies: {
    chalk: '^4.1.2',
    commander: '12.0.0',     // pinned exact
    'better-sqlite3': '^12.9.0',
  },
  devDependencies: {
    jest: '^29.7.0',
  },
};

const sampleLockfile = {
  name: '@example/cli',
  lockfileVersion: 3,
  packages: {
    '': { name: '@example/cli', version: '1.0.0' },
    'node_modules/chalk': { version: '4.1.2', resolved: 'https://registry.npmjs.org/chalk/-/chalk-4.1.2.tgz', integrity: 'sha512-...', dev: false },
    'node_modules/commander': { version: '12.0.0', resolved: 'https://registry.npmjs.org/commander/-/commander-12.0.0.tgz', integrity: 'sha512-...' },
    'node_modules/better-sqlite3': { version: '12.9.0', resolved: 'https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-12.9.0.tgz', integrity: 'sha512-...' },
    'node_modules/jest': { version: '29.7.0', resolved: 'https://registry.npmjs.org/jest/-/jest-29.7.0.tgz', integrity: 'sha512-...', dev: true },
    'node_modules/chalk/node_modules/ansi-styles': { version: '4.3.0', resolved: 'https://registry.npmjs.org/ansi-styles/-/ansi-styles-4.3.0.tgz', integrity: 'sha512-...' },
  },
};

describe('supply-chain: buildSbom', () => {
  test('produces summary with declared + resolved counts', () => {
    const r = buildSbom({ packageJson: samplePackageJson, lockfile: sampleLockfile });
    expect(r.summary.declaredDirect).toBe(3);
    expect(r.summary.declaredDev).toBe(1);
    expect(r.summary.resolvedTotal).toBe(5);
    expect(r.summary.withIntegrity).toBe(5);
    expect(r.summary.fromRegistry).toBe(5);
    expect(r.sbomHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('throws on missing packageJson', () => {
    expect(() => buildSbom({})).toThrow(/packageJson/);
  });

  test('counts resolved packages without integrity', () => {
    const lockfile = {
      packages: {
        'node_modules/x': { version: '1.0', resolved: 'https://registry.npmjs.org/x/-/x-1.0.tgz' }, // no integrity
        'node_modules/y': { version: '1.0', resolved: 'https://registry.npmjs.org/y/-/y-1.0.tgz', integrity: 'sha512-...' },
      },
    };
    const r = buildSbom({ packageJson: { name: 'p', version: '0.0.1' }, lockfile });
    expect(r.summary.withIntegrity).toBe(1);
    expect(r.summary.withoutIntegrity).toBe(1);
  });
});

describe('supply-chain: verifyLockfile', () => {
  test('clean alignment → ok', () => {
    const r = verifyLockfile({ packageJson: samplePackageJson, lockfile: sampleLockfile });
    expect(r.ok).toBe(true);
    expect(r.drifts).toEqual([]);
  });

  test('exact-pin mismatch → drift', () => {
    const lock = JSON.parse(JSON.stringify(sampleLockfile));
    lock.packages['node_modules/commander'].version = '12.0.1';
    const r = verifyLockfile({ packageJson: samplePackageJson, lockfile: lock });
    expect(r.ok).toBe(false);
    expect(r.drifts.find((d) => d.kind === 'version-mismatch')).toBeTruthy();
  });

  test('declared-not-resolved → drift', () => {
    const pkg = { ...samplePackageJson, dependencies: { ...samplePackageJson.dependencies, missing: '^1.0.0' } };
    const r = verifyLockfile({ packageJson: pkg, lockfile: sampleLockfile });
    expect(r.drifts.find((d) => d.kind === 'declared-not-resolved' && d.name === 'missing')).toBeTruthy();
  });

  test('resolved-not-declared → drift only with flagHoistedTransitives: true', () => {
    const lock = JSON.parse(JSON.stringify(sampleLockfile));
    lock.packages['node_modules/sneaky'] = { version: '0.0.1', resolved: 'https://registry.npmjs.org/sneaky/-/sneaky-0.0.1.tgz', integrity: 'sha512-...' };
    // Default: not flagged (hoisted transitives are normal npm behavior)
    const quiet = verifyLockfile({ packageJson: samplePackageJson, lockfile: lock });
    expect(quiet.drifts.find((d) => d.kind === 'resolved-not-declared')).toBeFalsy();
    // Opt-in: flagged
    const loud = verifyLockfile({ packageJson: samplePackageJson, lockfile: lock, flagHoistedTransitives: true });
    expect(loud.drifts.find((d) => d.kind === 'resolved-not-declared' && d.name === 'sneaky')).toBeTruthy();
  });
});

describe('supply-chain: auditDependencyShapes', () => {
  test('clean lockfile → no findings', () => {
    const r = auditDependencyShapes({ lockfile: sampleLockfile });
    expect(r.findings).toHaveLength(0);
    expect(r.summary.findings).toBe(0);
  });

  test('missing integrity → high-severity finding', () => {
    const lock = {
      packages: {
        'node_modules/risky': { version: '1.0', resolved: 'https://registry.npmjs.org/risky/-/risky-1.0.tgz' },
      },
    };
    const r = auditDependencyShapes({ lockfile: lock });
    expect(r.findings.find((f) => f.kind === 'missing-integrity' && f.severity === 'high')).toBeTruthy();
  });

  test('git URL → high-severity finding', () => {
    const lock = {
      packages: {
        'node_modules/sus': { version: 'git', resolved: 'git+https://github.com/sus/sus.git#abc123', integrity: 'sha512-...' },
      },
    };
    const r = auditDependencyShapes({ lockfile: lock });
    expect(r.findings.find((f) => f.kind === 'non-registry-source' && f.severity === 'high')).toBeTruthy();
  });

  test('file: URL → medium-severity finding', () => {
    const lock = {
      packages: {
        'node_modules/local': { version: '1.0', resolved: 'file:../local-pkg', integrity: 'sha512-...' },
      },
    };
    const r = auditDependencyShapes({ lockfile: lock });
    expect(r.findings.find((f) => f.kind === 'non-registry-source' && f.severity === 'medium')).toBeTruthy();
  });

  test('summary by severity + kind', () => {
    const lock = {
      packages: {
        'node_modules/a': { version: '1.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.tgz' }, // missing integrity
        'node_modules/b': { version: '1.0', resolved: 'git+https://github.com/x/b.git', integrity: 'sha512-...' },
        'node_modules/c': { version: '1.0', resolved: 'file:../c', integrity: 'sha512-...' },
      },
    };
    const r = auditDependencyShapes({ lockfile: lock });
    expect(r.summary.findings).toBe(3);
    expect(r.summary.bySeverity.high).toBe(2);
    expect(r.summary.bySeverity.medium).toBe(1);
  });

  test('throws when lockfile missing', () => {
    expect(() => auditDependencyShapes({})).toThrow(/lockfile/);
  });
});
