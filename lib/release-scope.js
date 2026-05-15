'use strict';

const fs = require('fs');
const path = require('path');

const REPORT_SCHEMA = 'recall_release_scope_report/v1';

const PUBLIC_PATTERNS = [
  'README.md',
  'RECALL-PATTERN.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'package.json',
  'package-lock.json',
  'release-scope-export.json',
  '.gitignore',
  '.gitlab-ci.yml',
  'AGENTS.md',
  'bin/**',
  'lib/**',
  'test/**',
  'docs/setup/**',
  'docs/examples/**',
  'docs/security/**',
  'scripts/configure-claude-desktop-recall.js',
  'scripts/export-public-mirror.js',
];

const PUBLIC_OVERRIDE_PATTERNS = [
  'docs/plans/research-extractions/**',
];

const EXCLUDED_PATTERNS = [
  'data/imports/**',
  'data/parity/**',
  'data/research-artifacts/**',
  'data/local-inputs/**',
  'downloads/**',
  'accounting-platform/**',
  'confluence/**',
  '.vscode/**',
  'docs/plans/**',
  'docs/agent-handoffs/**',
  'docs/ui-research/**',
  'docs/work-inbox/**',
  'docs/architecture/**',
  'docs/geo-recall-meridian-*.md',
  'docs/meridian-*.md',
  'docs/architecture/current-state-module-terrain-map.md',
  'docs/phase-2-class-w-migration-execution-plan.md',
  'docs/internal-hex-import-guide.pdf',
  'docs/security/internal-walkthrough.md',
  '*-core-feature-blueprint.md',
  '*-core-vs-feature-boundary-map.md',
  '*-hex-architecture-audit.md',
  '*-hex-feature-porting-plan.md',
  '*-phase-1-window-reference-implementation-prompt.md',
  'ingest-*.js',
  'scripts/download-*.js',
  'scripts/ingest-*.js',
  'scripts/mirror-*-to-confluence-*.js',
  'scripts/erdos-*.js',
  'test/erdos-*.js',
  'test/security-egress-scanner.test.js',
  'scripts/generate-v45-*',
  '.codex-tmp/**',
  '.recall/**',
  '.meridian/**',
  '.codex_research_bundle.txt',
  'toy-trace.jsonl',
];

const EXPERIMENTAL_PATTERNS = [
  'lib/brainstorming-*.js',
  'lib/commands/brainstorm.js',
  'lib/intelligence-*.js',
  'lib/commands/intelligence.js',
  'lib/knowledge-terrain-*.js',
  'lib/terrain-*.js',
  'lib/feature-*.js',
  'lib/commands/feature.js',
  'scripts/geo-metadata-dry-run.js',
  'test/brainstorm*.test.js',
  'test/intelligence*.test.js',
  'test/knowledge-terrain*.test.js',
  'test/terrain*.test.js',
  'test/feature*.test.js',
];

const PUBLIC_FEATURES = [
  {
    id: 'welcome-flow',
    status: 'release-candidate',
    commands: [
      'recall welcome doctor',
      'recall welcome discover',
      'recall welcome plan',
      'recall welcome organize',
      'recall welcome review',
      'recall welcome actions',
    ],
    promise: 'Help new users safely turn recent repos and AI sessions into draft, reviewable Recall memory.',
  },
  {
    id: 'history-import',
    status: 'release-candidate',
    commands: [
      'recall import-history scan',
      'recall import-history project-plan',
      'recall import-history upload-project',
      'recall import-history analyze',
      'recall import-history promote',
    ],
    promise: 'Stage imported history as draft evidence and require review before promotion.',
  },
  {
    id: 'local-kb-basics',
    status: 'release-candidate',
    commands: [
      'recall init',
      'recall add',
      'recall browse',
      'recall search',
      'recall status',
      'recall verify',
      'recall export',
    ],
    promise: 'Provide a local knowledge base workflow without network publication requirements.',
  },
  {
    id: 'open-source-readiness',
    status: 'release-candidate',
    commands: [
      'recall open-source readiness',
      'recall open-source release-scope',
      'recall open-source outsider-packet',
      'recall open-source outsider-transcript',
    ],
    promise: 'Make source-only readiness and outsider comprehension testable.',
  },
  {
    id: 'managed-chatgpt-relay',
    status: 'service-contract',
    commands: [
      'recall relay service-plan',
      'recall relay configure',
      'recall relay doctor',
      'recall relay pairing-packet',
      'recall relay agent-manifest',
      'recall relay connector-url',
    ],
    promise: 'Prepare local-first Recall for a paid recallmeridian.com relay so ChatGPT can reach local memory through a permanent HTTPS MCP endpoint.',
  },
];

const NON_RELEASE_SURFACES = [
  {
    id: 'raw-research-corpora',
    paths: ['data/imports/**', 'data/research-artifacts/**', 'docs/plans/**', 'confluence/**'],
    reason: 'Research imports, source packs, and extraction notes are project evidence, not public product content.',
  },
  {
    id: 'private-agent-handoffs',
    paths: ['docs/agent-handoffs/**'],
    reason: 'Handoffs can include private paths, local context, and unreviewed draft lessons.',
  },
  {
    id: 'domain-strategy-artifacts',
    paths: [
      '*-core-feature-blueprint.md',
      '*-core-vs-feature-boundary-map.md',
      '*-hex-architecture-audit.md',
      '*-hex-feature-porting-plan.md',
      '*-phase-1-window-reference-implementation-prompt.md',
      'docs/plans/private-domain-*',
      'scripts/ingest-private-domain*.js',
    ],
    reason: 'Domain-specific strategy and private project research should not ship as Recall product material.',
  },
  {
    id: 'downloaded-or-generated-artifacts',
    paths: ['data/parity/**', 'docs/internal-hex-import-guide.pdf', '.codex-tmp/**'],
    reason: 'Generated, binary, temporary, or downloaded artifacts need explicit archive approval before public release.',
  },
];

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function globToRegExp(pattern) {
  const normalized = normalizePath(pattern);
  let out = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === '*' && next === '*') {
      out += '.*';
      index += 1;
    } else if (char === '*') {
      out += '[^/]*';
    } else if ('\\.^$+?()[]{}|'.includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  out += '$';
  return new RegExp(out);
}

function matchesAny(relativePath, patterns) {
  const normalized = normalizePath(relativePath);
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

function listAllFiles(root, opts = {}) {
  const ignoreDirs = new Set(opts.ignoreDirs || ['.git', 'node_modules']);
  const files = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoreDirs.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) files.push(normalizePath(path.relative(root, fullPath)));
    }
  }
  walk(root);
  return files.sort();
}

function classifyPath(relativePath) {
  if (matchesAny(relativePath, PUBLIC_OVERRIDE_PATTERNS)) return 'public';
  if (matchesAny(relativePath, EXCLUDED_PATTERNS)) return 'excluded';
  if (matchesAny(relativePath, EXPERIMENTAL_PATTERNS)) return 'experimental';
  if (matchesAny(relativePath, PUBLIC_PATTERNS)) return 'public';
  return 'unspecified';
}

function summarizeClassifications(classifications) {
  const counts = {
    public: 0,
    experimental: 0,
    excluded: 0,
    unspecified: 0,
  };
  for (const item of classifications) counts[item.scope] += 1;
  return counts;
}

function findScopeIssues(classifications, opts = {}) {
  const findings = [];
  const releaseMode = opts.releaseMode || 'source';
  const publicExcluded = classifications.filter((item) => item.scope === 'excluded' && opts.requireWholeRepoPublic);
  if (publicExcluded.length) {
    findings.push({
      id: 'whole-repo-release-includes-excluded-surfaces',
      severity: 'blocker',
      title: 'Whole-repo release would include private or research-only surfaces.',
      detail: `${publicExcluded.length} excluded file(s) are present.`,
      remediation: 'Use a release allowlist/export branch or remove excluded surfaces before making the whole repo public.',
    });
  }

  const unspecified = classifications.filter((item) => item.scope === 'unspecified');
  if (unspecified.length) {
    findings.push({
      id: 'unspecified-release-scope',
      severity: 'warn',
      title: 'Some files are not classified into public, experimental, or excluded release scope.',
      detail: `${unspecified.length} unspecified file(s) found.`,
      sample: unspecified.slice(0, 12).map((item) => item.path),
      remediation: 'Classify these paths before a broader public release.',
    });
  }

  if (releaseMode === 'npm') {
    findings.push({
      id: 'npm-release-needs-separate-package-gate',
      severity: 'warn',
      title: 'Npm release requires package-specific checks in addition to release scope.',
      detail: 'This scope report describes public content boundaries, not npm provenance, publish dry-runs, or dependency registry availability.',
      remediation: 'Run open-source readiness with --release-mode npm and a package dry-run before npm publication.',
    });
  }

  return findings;
}

function evaluateReleaseScope(opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const files = listAllFiles(root, opts);
  const classifications = files.map((file) => ({
    path: file,
    scope: classifyPath(file),
  }));
  const findings = findScopeIssues(classifications, opts);
  const blockerCount = findings.filter((finding) => finding.severity === 'blocker').length;
  return {
    schemaVersion: REPORT_SCHEMA,
    generatedAt: opts.now || new Date().toISOString(),
    root,
    releaseMode: opts.releaseMode || 'source',
    status: blockerCount ? 'blocked' : 'ready_with_scope_notes',
    summary: {
      ...summarizeClassifications(classifications),
      findingCount: findings.length,
      blockerCount,
      warnCount: findings.filter((finding) => finding.severity === 'warn').length,
    },
    publicFeatures: PUBLIC_FEATURES,
    nonReleaseSurfaces: NON_RELEASE_SURFACES,
    releaseRules: {
      publicPatterns: PUBLIC_PATTERNS,
      publicOverridePatterns: PUBLIC_OVERRIDE_PATTERNS,
      experimentalPatterns: EXPERIMENTAL_PATTERNS,
      excludedPatterns: EXCLUDED_PATTERNS,
      wholeRepoPublicAllowed: false,
      sourceOnlyReleaseShouldUseAllowlist: true,
      npmReleaseAllowed: opts.releaseMode === 'npm',
    },
    findings,
    classifications,
  };
}

function assertSafeOutputRoot(root, outputDir) {
  const resolvedRoot = path.resolve(root);
  const resolvedOutput = path.resolve(outputDir);
  if (resolvedOutput === resolvedRoot || resolvedOutput.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Output directory must be outside the source root to avoid mixing public mirror files with the working repo.');
  }
  return resolvedOutput;
}

function exportReleaseScope(opts = {}) {
  if (!opts.outputDir) throw new Error('outputDir is required.');
  const root = path.resolve(opts.root || process.cwd());
  const outputDir = assertSafeOutputRoot(root, opts.outputDir);
  const includeExperimental = opts.includeExperimental !== false;
  const report = evaluateReleaseScope({
    root,
    releaseMode: opts.releaseMode || 'source',
    now: opts.now,
  });
  const includedScopes = new Set(['public']);
  if (includeExperimental) includedScopes.add('experimental');
  const files = report.classifications
    .filter((item) => includedScopes.has(item.scope))
    .map((item) => item.path)
    .sort();
  const written = [];
  if (!opts.dryRun) {
    for (const relativePath of files) {
      const sourcePath = path.join(root, relativePath);
      const targetPath = path.join(outputDir, relativePath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
      written.push(relativePath);
    }
    const manifest = {
      schemaVersion: 'recall_release_scope_export/v1',
      generatedAt: opts.now || new Date().toISOString(),
      sourceRoot: opts.includeSourceRoot ? root : '<SOURCE_ROOT>',
      releaseMode: report.releaseMode,
      includeExperimental,
      counts: {
        public: report.summary.public,
        experimental: includeExperimental ? report.summary.experimental : 0,
        copied: written.length,
      },
      excludedSurfaces: report.nonReleaseSurfaces,
      sourceOnlyWarning: report.releaseRules.sourceOnlyReleaseShouldUseAllowlist,
    };
    const manifestPath = path.join(outputDir, 'release-scope-export.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return {
    schemaVersion: 'recall_release_scope_export_plan/v1',
    generatedAt: opts.now || new Date().toISOString(),
    root,
    outputDir,
    dryRun: Boolean(opts.dryRun),
    includeExperimental,
    releaseMode: report.releaseMode,
    counts: {
      public: report.summary.public,
      experimental: includeExperimental ? report.summary.experimental : 0,
      excluded: report.summary.excluded,
      unspecified: report.summary.unspecified,
      selected: files.length,
      written: opts.dryRun ? 0 : written.length,
    },
    selectedFiles: files,
    manifestPath: opts.dryRun ? null : path.join(outputDir, 'release-scope-export.json'),
  };
}

module.exports = {
  REPORT_SCHEMA,
  PUBLIC_PATTERNS,
  EXPERIMENTAL_PATTERNS,
  EXCLUDED_PATTERNS,
  PUBLIC_FEATURES,
  NON_RELEASE_SURFACES,
  classifyPath,
  exportReleaseScope,
  evaluateReleaseScope,
  listAllFiles,
};
