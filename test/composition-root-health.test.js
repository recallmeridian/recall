'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REQUIRED_PORTS = [
  'IEntryRepository',
  'ISearchEngine',
  'ISchemaValidator',
  'IRedactionService',
  'ISigningService',
  'IDomainAdapter',
];

const PENDING_SEAMS = {
  publicationPolicy: { present: true, runtimeWired: false, requiredFor: ['GEO-SEC-013'] },
  intakeRouting: { present: true, runtimeWired: false, requiredFor: ['GEO-SEC-002A', 'GEO-SEC-002B'] },
  partitionFilter: { present: false, runtimeWired: false, requiredFor: ['GEO-SEC-004', 'GEO-SEC-006', 'GEO-SEC-022'] },
  auditPersistence: { present: false, runtimeWired: false, requiredFor: ['GEO-SEC-020'] },
  featureCapability: { present: false, runtimeWired: false, requiredFor: ['GEO-SEC-017', 'GEO-SEC-018'] },
};

const METHOD_SHAPES = {
  IEntryRepository: ['getById', 'list', 'create', 'update', 'delete'],
  ISearchEngine: ['search'],
  ISchemaValidator: ['validate', 'extendSchema'],
  IRedactionService: ['redact'],
  ISigningService: ['sign', 'verify'],
  IDomainAdapter: ['extendSchema', 'rerankWeight', 'mountRoutes'],
};

function adapterName(adapter) {
  if (!adapter) return '';
  return adapter.constructor && adapter.constructor.name
    ? adapter.constructor.name
    : typeof adapter;
}

function buildHealthFromAdapters(adapters, opts = {}) {
  const blockers = opts.blockers || [];
  const failures = [];
  const ports = {};

  for (const port of REQUIRED_PORTS) {
    const adapter = adapters && adapters[port];
    const present = adapter !== undefined && adapter !== null;
    const missingMethods = present
      ? METHOD_SHAPES[port].filter((method) => typeof adapter[method] !== 'function')
      : METHOD_SHAPES[port].slice();
    ports[port] = {
      present,
      adapter: present ? adapterName(adapter) : '',
      missingMethods,
    };
    if (!present) failures.push({ type: 'missing_adapter', port });
    else if (missingMethods.length > 0) failures.push({ type: 'missing_methods', port, methods: missingMethods });
  }

  return {
    ok: blockers.length === 0 && failures.length === 0,
    runtimeMode: 'recall-local',
    checkedAt: '2026-05-03T00:00:00.000Z',
    blockers,
    failures,
    ports,
    pendingSeams: PENDING_SEAMS,
  };
}

function loadCoreHealth(coreLoader = () => require('../lib/meridian-core')) {
  let registry;
  let dataDir;
  let core;
  try {
    // Core-boundary check only. This card must not modify private adjacent
    // checkouts to make the import succeed.
    core = coreLoader();
  } catch (err) {
    return buildHealthFromAdapters({}, {
      blockers: [{
        type: 'core_import_failed',
        packageName: 'lib/meridian-core',
        code: err.code || err.name,
        message: err.message,
      }],
    });
  }

  try {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-sec-023-core-'));
    registry = core.buildLocalRegistry({ dataDir });
    return buildHealthFromAdapters({
      IEntryRepository: registry.get('repository', 'geo-sec-023'),
      ISearchEngine: registry.get('search'),
      ISchemaValidator: null,
      IRedactionService: null,
      ISigningService: registry.get('signing'),
      IDomainAdapter: registry.get('domain'),
    });
  } catch (err) {
    return buildHealthFromAdapters({}, {
      blockers: [{
        type: 'core_registry_failed',
        packageName: 'lib/meridian-core',
        code: err.code || err.name,
        message: err.message,
      }],
    });
  } finally {
    if (registry && typeof registry.close === 'function') registry.close();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('GEO-SEC-023 composition-root health', () => {
  test('reports core import failures as operational blockers', () => {
    const health = loadCoreHealth(() => {
      const err = new Error('Cannot find module "lib/meridian-core"');
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    });

    expect(health.ok).toBe(false);
    expect(health.blockers[0]).toMatchObject({
      type: 'core_import_failed',
      packageName: 'lib/meridian-core',
      code: 'MODULE_NOT_FOUND',
    });
    expect(health.blockers[0].message).toContain('lib/meridian-core');
  });

  test('reports real core composition-root health without hiding missing registry ports', () => {
    const health = loadCoreHealth();

    expect(health.blockers).toEqual([]);
    for (const port of REQUIRED_PORTS) {
      expect(health.ports[port]).toBeDefined();
    }
    expect(health.ports.IEntryRepository).toMatchObject({
      present: true,
      adapter: 'KBStoreEntryRepository',
      missingMethods: [],
    });
    expect(health.ports.ISearchEngine).toMatchObject({
      present: true,
      adapter: 'HybridSearchEngine',
      missingMethods: [],
    });
    expect(health.ports.ISigningService).toMatchObject({
      present: true,
      adapter: 'NullSigningService',
      missingMethods: [],
    });
    expect(health.ports.IDomainAdapter).toMatchObject({
      present: true,
      adapter: 'NullDomainAdapter',
      missingMethods: [],
    });
    expect(health.failures).toEqual(expect.arrayContaining([
      { type: 'missing_adapter', port: 'ISchemaValidator' },
      { type: 'missing_adapter', port: 'IRedactionService' },
    ]));
  });

  test('enumerates all required ports and all known pending geomorphic seams', () => {
    const health = buildHealthFromAdapters(Object.fromEntries(
      REQUIRED_PORTS.map((port) => [
        port,
        Object.fromEntries([
          ['constructor', { name: `${port}Adapter` }],
          ...METHOD_SHAPES[port].map((method) => [method, () => {}]),
        ]),
      ])
    ));

    expect(health.ok).toBe(true);
    expect(Object.keys(health.ports).sort()).toEqual([...REQUIRED_PORTS].sort());
    expect(Object.keys(health.pendingSeams).sort()).toEqual([
      'auditPersistence',
      'featureCapability',
      'intakeRouting',
      'partitionFilter',
      'publicationPolicy',
    ].sort());
    expect(health.pendingSeams.publicationPolicy).toMatchObject({
      present: true,
      runtimeWired: false,
      requiredFor: ['GEO-SEC-013'],
    });
    expect(health.pendingSeams.intakeRouting).toMatchObject({
      present: true,
      runtimeWired: false,
      requiredFor: ['GEO-SEC-002A', 'GEO-SEC-002B'],
    });
  });

  test('missing required adapters are failures, while pending seams do not affect ok', () => {
    const health = buildHealthFromAdapters({
      IEntryRepository: {},
      ISearchEngine: {},
      ISchemaValidator: {},
      IRedactionService: {},
      ISigningService: {},
    });

    expect(health.ok).toBe(false);
    expect(health.failures).toContainEqual({
      type: 'missing_adapter',
      port: 'IDomainAdapter',
    });
    expect(health.pendingSeams.publicationPolicy.present).toBe(true);
    expect(health.pendingSeams.featureCapability.present).toBe(false);
  });

  test('adapters missing required method shapes are failures', () => {
    const health = buildHealthFromAdapters(Object.fromEntries(
      REQUIRED_PORTS.map((port) => [
        port,
        Object.fromEntries([
          ['constructor', { name: `${port}Adapter` }],
          ...METHOD_SHAPES[port].slice(1).map((method) => [method, () => {}]),
        ]),
      ])
    ));

    expect(health.ok).toBe(false);
    expect(health.failures).toContainEqual({
      type: 'missing_methods',
      port: 'IEntryRepository',
      methods: ['getById'],
    });
  });
});
