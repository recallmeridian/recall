'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalSha256 } = require('./canonical-json');
const { listFeatureManifests, registerFeatureManifest } = require('./feature-registry');
const { validateFeatureManifest } = require('./feature-manifest');
const { buildPolymarketToolingFeatureSpecs } = require('./polymarket-tooling-feature-specs');

const CURATED_MANIFESTS = [
  'docs/examples/features/recall-project-health-brief.manifest.json',
  'docs/examples/features/knowledge-terrain-atlas.manifest.json',
  'docs/examples/features/recall-app-port.manifest.json',
];

const DEFAULT_FEATURE_IDS = new Set([
  'audit-debt-list',
  'audit-debt-record',
  'audit-debt-scan',
  'audit-debt-verify',
  'feature-approvals',
  'feature-approve',
  'feature-build-finish-check',
  'feature-build-improve',
  'feature-build-ledger-verify',
  'feature-build-plan',
  'feature-build-status',
  'feature-deny',
  'feature-example-run',
  'feature-health',
  'feature-list',
  'feature-manifest-check',
  'feature-polymarket-tooling-specs',
  'feature-register',
  'feature-review',
  'feature-runs',
  'feature-seed-core-registry',
  'feature-verify-ledgers',
  'import-history-analyze',
  'import-history-import',
  'import-history-project-plan',
  'import-history-promote',
  'import-history-scan',
  'import-history-upload-project',
  'import-history-upload-projects',
  'knowledge-history',
  'knowledge-rollback-plan',
  'knowledge-terrain-atlas',
  'knowledge-transition',
  'knowledge-verify',
  'open-source-export-scope',
  'open-source-outsider-packet',
  'open-source-outsider-transcript',
  'open-source-outsider-trial',
  'open-source-readiness',
  'open-source-release-scope',
  'polymarket-evaluate-template',
  'polymarket-phase1-gate-status-heartbeat',
  'polymarket-services-status',
  'polymarket-strategy-catalog-status',
  'recall-add',
  'recall-app-port',
  'recall-browse',
  'recall-config',
  'recall-export',
  'recall-ingest',
  'recall-init',
  'recall-project-health-brief',
  'recall-query',
  'recall-search',
  'recall-status',
  'recall-ui',
  'recall-verify',
  'release-mirror',
  'security-egress-scan',
  'security-ledger-list',
  'security-ledger-verify',
  'security-anchor-create',
  'security-anchor-list',
  'security-anchor-verify',
  'security-promotion-eval',
  'security-dream-run',
  'security-dream-list',
  'security-dream-verify',
  'security-ensemble-eval',
  'security-canary-plant',
  'security-canary-list',
  'security-canary-check',
  'security-canary-verify',
  'security-bridge-degree-check',
  'security-decay-tiers',
  'security-decay-evaluate',
  'security-drift-check',
  'security-dashboard',
  'security-negprom-record',
  'security-negprom-summary',
  'security-negprom-verify',
  'security-adversary-run',
  'security-adversary-categories',
  'security-audit-ingest',
  'security-audit-list',
  'security-audit-promote',
  'security-audit-reject',
  'security-audit-verify',
  'security-collusion-check',
  'security-sbom',
  'security-lockfile-verify',
  'security-dep-audit',
  'security-arch-review-queue',
  'security-arch-review-list',
  'security-arch-review-sign',
  'security-arch-review-verify',
  'openclaw-propose-action',
  'welcome-actions',
  'welcome-discover',
  'welcome-doctor',
  'welcome-organize',
  'welcome-organize-apply',
  'welcome-organize-check',
  'welcome-plan',
  'welcome-review',
  'welcome-walkthrough',
]);

const BUILT_FEATURE_GROUPS = [
  { group: '', source: 'bin/meridian.js', commands: ['init', 'add', 'search', 'ingest', 'push', 'pull', 'verify', 'browse', 'query', 'status', 'config', 'export', 'ui', 'embed'] },
  { group: 'research', source: 'lib/commands/research.js', commands: ['init', 'problem', 'trace', 'status', 'list', 'workflow', 'next', 'step', 'promote'] },
  { group: 'import-history', source: 'lib/commands/import-history.js', commands: ['scan', 'project-plan', 'import', 'upload-project', 'upload-projects', 'analyze', 'promote'] },
  { group: 'welcome', source: 'lib/commands/welcome.js', commands: ['walkthrough', 'doctor', 'discover', 'plan', 'review', 'actions', 'organize', 'organize-check', 'organize-apply'] },
  { group: 'brainstorm', source: 'lib/commands/brainstorm.js', commands: ['preflight', 'auto-session', 'runner-diagnose'] },
  { group: 'audit-debt', source: 'lib/commands/audit-debt.js', commands: ['scan', 'list', 'record', 'verify'] },
  { group: 'intelligence', source: 'lib/commands/intelligence.js', commands: ['session-start', 'preflight-decision', 'health', 'outcome-record', 'outcome-summary', 'outcome-score', 'preflight', 'cycle-run', 'agent-handoff-template', 'agent-handoff', 'agent-handoff-check', 'handoff-promote', 'agent-handoff-list', 'agent-hard-cases', 'agent-router-readiness', 'artifact-list', 'artifact-store', 'curriculum-plan', 'failure-mine', 'evaluator-run', 'verifier-adapters', 'verifier-check', 'debate-check', 'benchmark-pack-list', 'benchmark-pack-install', 'benchmark-pack-answers', 'benchmark-expand', 'benchmark-add', 'benchmark-list', 'benchmark-batch-run', 'benchmark-run', 'promotion-check', 'trace-to-skill', 'skill-list', 'eval-cycle', 'eval-history', 'eval-verify'] },
  { group: 'feature', source: 'lib/commands/feature.js', commands: ['review', 'runs', 'verify-ledgers', 'health', 'ecosystem-health', 'bridge-map', 'terrain-source-pack', 'terrain-atlas', 'terrain-snapshot', 'terrain-render', 'terrain-diff', 'terrain-validate', 'terrain-anchor-suggestions', 'terrain-morphology', 'terrain-validation-delta', 'terrain-relationship-suggestions', 'terrain-anchor-review', 'terrain-relationship-review', 'terrain-relationship-approvals-list', 'terrain-relationship-approvals-verify', 'terrain-relationships-export', 'terrain-relationship-validation-delta', 'terrain-review-workbench', 'terrain-anchor-approvals-list', 'terrain-anchor-approvals-verify', 'terrain-anchors-export', 'terrain-insights', 'terrain-actions', 'terrain-actions-append', 'terrain-actions-list', 'terrain-actions-verify', 'reconsolidation-append', 'reconsolidation-verify', 'build-plan', 'build-status', 'build-finish-check', 'build-improve', 'build-ledger-verify', 'example-run', 'seed-core-registry', 'polymarket-tooling-specs', 'register', 'list', 'manifest-check', 'approvals', 'approve', 'deny'] },
  { group: 'knowledge', source: 'lib/commands/knowledge.js', commands: ['transition', 'verify', 'history', 'rollback-plan'] },
  { group: 'open-source', source: 'lib/commands/open-source.js', commands: ['release-scope', 'export-scope', 'readiness', 'outsider-trial', 'outsider-packet', 'outsider-transcript', 'publish-mirror'] },
  { group: 'relay', source: 'lib/commands/relay.js', commands: ['service-plan', 'configure', 'doctor', 'status', 'connector-url', 'pairing-packet', 'agent-manifest'] },
  { group: 'release', source: 'scripts/export-public-mirror.js', commands: ['mirror'] },
  { group: 'trace', source: 'lib/commands/trace.js', commands: ['detect-basins', 'reflect', 'recommend', 'verify', 'promote'] },
  { group: 'llm', source: 'lib/commands/llm.js', commands: ['config', 'status', 'test'] },
  { group: 'arch', source: 'lib/commands/arch-audit.js', commands: ['arch-audit'] },
  { group: 'specialist', source: 'lib/commands/specialist.js', commands: ['list', 'show', 'run'] },
  { group: 'consolidate', source: 'lib/commands/consolidate.js', commands: ['detect', 'judge', 'review', 'approve', 'reject', 'apply'] },
  { group: 'security', source: 'lib/commands/security.js', commands: ['egress-scan', 'health', 'health-history', 'health-verify', 'synthesize', 'synthesis-list', 'synthesis-verify', 'ledger-list', 'ledger-verify', 'anchor-create', 'anchor-list', 'anchor-verify', 'promotion-eval', 'dream-run', 'dream-list', 'dream-verify', 'ensemble-eval', 'canary-plant', 'canary-list', 'canary-check', 'canary-verify', 'bridge-degree-check', 'decay-tiers', 'decay-evaluate', 'drift-check', 'dashboard', 'negprom-record', 'negprom-summary', 'negprom-verify', 'adversary-run', 'adversary-categories', 'audit-ingest', 'audit-list', 'audit-promote', 'audit-reject', 'audit-verify', 'collusion-check', 'sbom', 'lockfile-verify', 'dep-audit', 'arch-review-queue', 'arch-review-list', 'arch-review-sign', 'arch-review-verify'] },
  { group: 'openclaw', source: 'lib/commands/openclaw.js', commands: ['propose-action'] },
];

const READ_ONLY_TERMS = [
  'search', 'browse', 'query', 'status', 'doctor', 'discover', 'review',
  'actions', 'check', 'list', 'health', 'verify', 'scope', 'readiness',
  'trial', 'packet', 'transcript', 'summary', 'score', 'preflight',
  'template', 'adapters', 'manifest-check', 'runs', 'history', 'rollback',
  'url', 'plan', 'map', 'atlas', 'render', 'diff', 'validate', 'suggestions',
  'morphology', 'export', 'insights', 'service-plan', 'pairing-packet',
  'agent-manifest',
];

const LIVE_WRITE_FEATURES = new Set(['recall-push', 'recall-pull', 'relay-configure']);

function featureId(group, command) {
  return group ? `${group}-${command}` : `recall-${command}`;
}

function title(id) {
  return id.split('-').map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part)).join(' ');
}

function riskFor(id, command) {
  if (LIVE_WRITE_FEATURES.has(id)) return 'live-write';
  if (READ_ONLY_TERMS.some((term) => command.includes(term) || id.includes(term))) return 'read-only';
  return 'paper-write';
}

function outputFor(risk, command) {
  if (risk === 'read-only') return 'projection';
  if (command.includes('export') || command.includes('packet') || command.includes('render')) return 'artifact';
  return 'local_record';
}

function generatedManifest(groupDef, command) {
  const id = featureId(groupDef.group, command);
  const risk = riskFor(id, command);
  const tool = groupDef.group ? `recall.${groupDef.group}` : 'recall.cli';
  const action = groupDef.group ? `${groupDef.group}:${command}` : `recall:${command}`;
  const capability = { tool, action };
  const pathLabel = groupDef.group ? `recall ${groupDef.group} ${command}` : `recall ${command}`;
  const approvalRequired = risk === 'paper-write' || risk === 'live-write';
  return {
    feature_id: id,
    name: title(id),
    purpose: `Expose the built ${pathLabel} capability through the local Recall feature registry.`,
    owner_id: 'recall-core-team',
    runtime_mode: 'recall-local',
    lifecycle_state: 'local_validated',
    local_only: true,
    publishable: false,
    risk_level: risk,
    required_capabilities: [capability],
    required_partitions: ['trusted_kb', 'audit_sediment'],
    denied_actions: [
      { tool: 'meridian.push', action: 'publish:network' },
      { tool: 'shell', action: 'run:code' },
      { tool: 'database', action: 'sql:raw' },
    ],
    human_approval_required_for: approvalRequired ? [capability] : [],
    output_type: outputFor(risk, command),
    audit_level: risk === 'live-write' ? 'high' : 'standard',
    validation_method: 'npm.cmd test',
    source_refs: [`repo:${groupDef.source}`, 'repo:test'],
    risk_notes: `${approvalRequired ? 'Human approval is required before execution. ' : ''}Generated registry seed manifest for built local CLI surface: ${pathLabel}.`.trim(),
  };
}

function loadCuratedManifests(root) {
  return CURATED_MANIFESTS
    .map((relativePath) => path.join(root, relativePath))
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function bucketForFeature(featureId) {
  return DEFAULT_FEATURE_IDS.has(featureId) ? 'default' : 'feature_bank';
}

function filterCatalogByBucket(catalog, bucket = 'default') {
  if (bucket === 'all') return catalog;
  if (bucket === 'default') return catalog.filter((manifest) => bucketForFeature(manifest.feature_id) === 'default');
  if (bucket === 'feature_bank') return catalog.filter((manifest) => bucketForFeature(manifest.feature_id) === 'feature_bank');
  throw new Error(`Unknown feature catalog bucket "${bucket}". Expected: default, feature_bank, all`);
}

function buildCoreFeatureCatalog(root = process.cwd(), options = {}) {
  const manifests = [
    ...loadCuratedManifests(root),
    ...buildPolymarketToolingFeatureSpecs().map((feature) => feature.manifest),
  ];
  const seen = new Set(manifests.map((manifest) => manifest.feature_id));
  for (const groupDef of BUILT_FEATURE_GROUPS) {
    for (const command of groupDef.commands) {
      const id = featureId(groupDef.group, command);
      if (seen.has(id)) continue;
      manifests.push(generatedManifest(groupDef, command));
      seen.add(id);
    }
  }
  const catalog = manifests.map((manifest) => validateFeatureManifest(manifest).manifest)
    .sort((left, right) => left.feature_id.localeCompare(right.feature_id));
  return filterCatalogByBucket(catalog, options.bucket || 'default');
}

function seedCoreFeatureRegistry({ registryPath, root = process.cwd(), projectId = 'recall-local', actor = 'feature-registry-seed', now, force = false, bucket = 'default' } = {}) {
  if (!registryPath) throw new Error('registryPath is required');
  const existing = new Map(listFeatureManifests(registryPath).map((record) => [record.feature_id, record]));
  const catalog = buildCoreFeatureCatalog(root, { bucket });
  const results = [];
  for (const manifest of catalog) {
    const validation = validateFeatureManifest(manifest);
    if (!validation.ok) {
      results.push({ feature_id: manifest.feature_id, status: 'invalid', errors: validation.errors });
      continue;
    }
    const manifestHash = canonicalSha256(validation.manifest);
    const current = existing.get(validation.manifest.feature_id);
    if (!force && current && current.manifestHash === manifestHash) {
      results.push({ feature_id: validation.manifest.feature_id, status: 'unchanged', manifestHash });
      continue;
    }
    const record = registerFeatureManifest(registryPath, validation.manifest, { actor, projectId, now });
    results.push({ feature_id: record.feature_id, status: 'registered', manifestHash: record.manifestHash, recordHash: record.recordHash });
  }
  return {
    ok: results.every((result) => result.status !== 'invalid'),
    registryPath,
    bucket,
    catalogCount: catalog.length,
    registered: results.filter((result) => result.status === 'registered').length,
    unchanged: results.filter((result) => result.status === 'unchanged').length,
    invalid: results.filter((result) => result.status === 'invalid'),
    results,
  };
}

module.exports = {
  BUILT_FEATURE_GROUPS,
  CURATED_MANIFESTS,
  DEFAULT_FEATURE_IDS,
  buildCoreFeatureCatalog,
  bucketForFeature,
  seedCoreFeatureRegistry,
};
