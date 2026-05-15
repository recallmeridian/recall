'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_IGNORES = new Set([
  '.git',
  'node_modules',
  'downloads',
  '.codex-tmp',
  '.meridian',
  '.recall',
  '.vscode',
]);

const DEFAULT_PATH_REFERENCE_IGNORES = [
  '.codex_research_bundle.txt',
  'data/imports/',
  'data/local-inputs/',
  'data/research-artifacts/',
  'docs/architecture/current-state-module-terrain-map.md',
  'docs/phase-2-class-w-migration-execution-plan.md',
  'docs/plans/',
  '*-core-feature-blueprint.md',
  '*-core-vs-feature-boundary-map.md',
  '*-hex-architecture-audit.md',
  '*-hex-feature-porting-plan.md',
  '*-phase-1-window-reference-implementation-prompt.md',
  'test/erdos-*.js',
];

const TEXT_EXTENSIONS = new Set([
  '.js',
  '.json',
  '.md',
  '.txt',
  '.yml',
  '.yaml',
  '.toml',
  '.ps1',
  '.cmd',
  '.sh',
]);

const STAGE_ORDER = {
  'private-alpha': 1,
  'limited-public': 2,
};

const RELEASE_MODES = new Set(['source', 'npm']);

function exists(root, relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function readText(root, relativePath) {
  const filePath = path.join(root, relativePath);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function isTextFile(filePath) {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function listFiles(root, options = {}) {
  const ignoreDirs = new Set([...(options.ignoreDirs || DEFAULT_IGNORES)]);
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoreDirs.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && isTextFile(fullPath)) {
        files.push(fullPath);
      }
    }
  }
  walk(root);
  return files;
}

function addFinding(findings, finding) {
  findings.push({
    id: finding.id,
    severity: finding.severity || 'warn',
    stage: finding.stage || 'private-alpha',
    status: finding.status || 'open',
    title: finding.title,
    detail: finding.detail || '',
    file: finding.file || '',
    remediation: finding.remediation || '',
  });
}

function stageAtLeast(currentStage, requiredStage) {
  return (STAGE_ORDER[currentStage] || 1) >= (STAGE_ORDER[requiredStage] || 1);
}

function checkReadme(root, findings) {
  if (!exists(root, 'README.md')) {
    addFinding(findings, {
      id: 'readme-missing',
      severity: 'blocker',
      title: 'README.md is missing.',
      remediation: 'Add a README that explains Recall, the first useful workflow, core concepts, and current limits.',
    });
    return;
  }
  const readme = readText(root, 'README.md').toLowerCase();
  const requiredSections = [
    ['readme-what-this-is', 'what this project is', 'README lacks a clear "What this project is" section.'],
    ['readme-first-workflow', 'first useful workflow', 'README lacks a first useful workflow section.'],
    ['readme-core-concepts', 'core concepts', 'README lacks a core concepts section.'],
    ['readme-not-ready', 'not ready', 'README lacks a "what this is not ready for" section.'],
  ];
  for (const [id, needle, title] of requiredSections) {
    if (!readme.includes(needle)) {
      addFinding(findings, {
        id,
        severity: 'blocker',
        title,
        file: 'README.md',
        remediation: `Add a concise README section containing "${needle}".`,
      });
    }
  }
}

function checkGovernance(root, findings, stage) {
  const files = [
    ['CONTRIBUTING.md', 'contributing-missing', 'Contribution guide is missing.'],
    ['SECURITY.md', 'security-missing', 'Security policy is missing.'],
  ];
  for (const [file, id, title] of files) {
    if (!exists(root, file)) {
      addFinding(findings, {
        id,
        severity: stageAtLeast(stage, 'limited-public') ? 'blocker' : 'warn',
        stage: 'limited-public',
        title,
        file,
        remediation: `Add ${file} before limited public open source.`,
      });
    }
  }
}

function checkPackage(root, findings, stage, releaseMode) {
  if (!exists(root, 'package.json')) {
    addFinding(findings, {
      id: 'package-json-missing',
      severity: 'blocker',
      title: 'package.json is missing.',
      remediation: 'Add package.json before release checks can pass.',
    });
    return;
  }
  let pkg;
  try {
    pkg = JSON.parse(readText(root, 'package.json'));
  } catch (err) {
    addFinding(findings, {
      id: 'package-json-invalid',
      severity: 'blocker',
      title: 'package.json is invalid JSON.',
      detail: err.message,
      file: 'package.json',
      remediation: 'Fix package.json parsing errors.',
    });
    return;
  }
  if (pkg.license !== 'Apache-2.0') {
    addFinding(findings, {
      id: 'package-license',
      severity: 'blocker',
      title: 'package.json license is not Apache-2.0.',
      file: 'package.json',
      remediation: 'Set license to Apache-2.0 or document the selected release license.',
    });
  }
  if (!pkg.bin || !pkg.bin.recall || !pkg.bin.meridian) {
    addFinding(findings, {
      id: 'package-bin',
      severity: 'blocker',
      title: 'package.json does not expose both recall and meridian bins.',
      file: 'package.json',
      remediation: 'Expose both CLI names before alpha release.',
    });
  }
  if (stageAtLeast(stage, 'limited-public') && releaseMode === 'npm' && !pkg.files && !exists(root, '.npmignore')) {
    addFinding(findings, {
      id: 'package-publish-allowlist',
      severity: 'blocker',
      stage: 'limited-public',
      title: 'No package publish allowlist or .npmignore exists.',
      file: 'package.json',
      remediation: 'Add package.json files allowlist or .npmignore before public npm packaging.',
    });
  }
  if (stageAtLeast(stage, 'limited-public')) {
    const dependencyGroups = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    for (const group of dependencyGroups) {
      for (const [name, spec] of Object.entries(pkg[group] || {})) {
        if (typeof spec !== 'string' || !spec.startsWith('file:')) continue;
        addFinding(findings, {
          id: `package-local-dependency:${name.replace(/[^a-zA-Z0-9]+/g, '-')}`,
          severity: releaseMode === 'npm' ? 'blocker' : 'warn',
          stage: 'limited-public',
          title: releaseMode === 'npm'
            ? 'Package uses a local file dependency.'
            : 'Source-only release depends on a local file dependency.',
          detail: `${name} resolves from ${spec}`,
          file: 'package.json',
          remediation: releaseMode === 'npm'
            ? 'Publish the dependency, move to a documented monorepo workspace, or exclude npm packaging from the limited-public release path.'
            : 'Keep npm packaging disabled for this release mode and document the sibling checkout or workspace setup.',
        });
      }
    }
  }
}

function checkReleaseModeDocs(root, findings, stage, releaseMode) {
  if (!stageAtLeast(stage, 'limited-public')) return;
  if (releaseMode !== 'source') return;
  if (exists(root, 'docs/setup/source-only-release.md')) return;
  addFinding(findings, {
    id: 'source-only-release-doc-missing',
    severity: 'blocker',
    stage: 'limited-public',
    title: 'Source-only limited-public release lacks setup documentation.',
    file: 'docs/setup/source-only-release.md',
    remediation: 'Document the source-only install path and the fact that npm packaging requires a package dry run plus registry-safe dependencies.',
  });
}

function isActiveSurface(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  return (
    normalized === 'README.md' ||
    normalized === 'package.json' ||
    normalized.startsWith('bin/') ||
    normalized.startsWith('lib/') ||
    normalized.startsWith('test/') ||
    normalized.startsWith('docs/examples/')
  );
}

function normalizeRelativePath(relativePath) {
  return relativePath.replace(/\\/g, '/');
}

function shouldSkipPathReferenceScan(relativePath, options = {}) {
  const normalized = normalizeRelativePath(relativePath);
  const ignores = options.pathReferenceIgnores || DEFAULT_PATH_REFERENCE_IGNORES;
  return ignores.some((ignore) => {
    const normalizedIgnore = normalizeRelativePath(ignore);
    if (normalizedIgnore.endsWith('/')) return normalized.startsWith(normalizedIgnore);
    if (normalizedIgnore.includes('*')) {
      const escaped = normalizedIgnore.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp(`^${escaped}$`).test(normalized);
    }
    return normalized === normalizedIgnore;
  });
}

function scanPathReferences(root, findings, options = {}) {
  const patterns = [
    {
      id: 'onedrive-path-reference',
      label: 'OneDrive path reference',
      regex: /(?:[A-Z]:(?:\\{1,2})Users(?:\\{1,2})[^\\\n]+(?:\\{1,2})OneDrive(?:\\{1,2})|~\/OneDrive\/|\/Users\/[^/\n]+\/OneDrive\/|\/home\/[^/\n]+\/OneDrive\/)/i,
    },
    {
      id: 'downloads-path-reference',
      label: 'Downloads path reference',
      regex: /(?:[A-Z]:(?:\\{1,2})Users(?:\\{1,2})[^\\\n]+(?:\\{1,2})Downloads(?:\\{1,2})|~\/Downloads\/|\/Users\/[^/\n]+\/Downloads\/|\/home\/[^/\n]+\/Downloads\/|downloads\/research)/i,
    },
    {
      id: 'private-user-path-reference',
      label: 'Private absolute user path reference',
      regex: /C:(?:\\{1,2})Users(?:\\{1,2})jesse(?:\\{1,2})/i,
    },
  ];
  for (const filePath of listFiles(root)) {
    const relativePath = path.relative(root, filePath);
    if (shouldSkipPathReferenceScan(relativePath, options)) continue;
    const text = fs.readFileSync(filePath, 'utf8');
    if (text.includes('open-source-readiness: allow-private-path-fixtures')) continue;
    for (const pattern of patterns) {
      if (!pattern.regex.test(text)) continue;
      const active = isActiveSurface(relativePath);
      addFinding(findings, {
        id: `${pattern.id}:${relativePath.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
        severity: active ? 'blocker' : 'warn',
        title: `${pattern.label} found${active ? ' in active release surface' : ''}.`,
        file: relativePath,
        remediation: active
          ? 'Replace active private/local paths with relative paths or documented placeholders.'
          : 'Confirm this is historical evidence or move it out of the public release surface.',
      });
    }
  }
}

function summarize(findings, stage) {
  const blockerCount = findings.filter((finding) => finding.severity === 'blocker').length;
  const warnCount = findings.filter((finding) => finding.severity === 'warn').length;
  return {
    stage,
    status: blockerCount === 0 ? 'ready' : 'blocked',
    blockerCount,
    warnCount,
    findingCount: findings.length,
  };
}

function evaluateOpenSourceReadiness(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const stage = options.stage || 'private-alpha';
  const releaseMode = options.releaseMode || options['release-mode'] || 'npm';
  if (!STAGE_ORDER[stage]) {
    throw new Error(`Unknown open-source readiness stage "${stage}". Expected: ${Object.keys(STAGE_ORDER).join(', ')}`);
  }
  if (!RELEASE_MODES.has(releaseMode)) {
    throw new Error(`Unknown open-source release mode "${releaseMode}". Expected: ${Array.from(RELEASE_MODES).join(', ')}`);
  }
  const findings = [];
  checkReadme(root, findings);
  checkGovernance(root, findings, stage);
  checkPackage(root, findings, stage, releaseMode);
  checkReleaseModeDocs(root, findings, stage, releaseMode);
  scanPathReferences(root, findings);
  return {
    root,
    releaseMode,
    principle: 'External Input Gain > External Damage Risk',
    definition: 'Ready means safe, useful, understandable, and resilient enough that external usage improves the system faster than it degrades it.',
    summary: summarize(findings, stage),
    findings,
  };
}

module.exports = {
  evaluateOpenSourceReadiness,
  listFiles,
};
