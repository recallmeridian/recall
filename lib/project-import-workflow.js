'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULT_PROJECT } = require('./history-import');

const PLAN_SCHEMA = 'project_import_plan/v1';

const SAFE_IGNORES = [
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  '.venv',
  'venv',
  '__pycache__',
  '.env',
  '.env.local',
];

function pathHasUnsafeActiveSource(filePath = '') {
  const text = String(filePath || '').toLowerCase();
  return text.includes('\\onedrive\\')
    || text.includes('/onedrive/')
    || text.includes('\\downloads\\')
    || text.includes('/downloads/');
}

function safeProjectId(value = '') {
  return String(value || DEFAULT_PROJECT)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    || DEFAULT_PROJECT;
}

function detectProjectFiles(rootPath) {
  const files = ['README.md', 'package.json', 'pyproject.toml', 'AGENTS.md', 'CLAUDE.md'];
  return files.filter((name) => fs.existsSync(path.join(rootPath, name)));
}

function buildProjectImportPlan(input = {}, opts = {}) {
  const projectPath = path.resolve(input.path || input.projectPath || '.');
  const exists = fs.existsSync(projectPath);
  const isDirectory = exists && fs.statSync(projectPath).isDirectory();
  const projectName = input.projectName || path.basename(projectPath);
  const stagingProject = safeProjectId(input.stagingProject || opts.stagingProject || DEFAULT_PROJECT);
  const targetProject = safeProjectId(input.targetProject || projectName);
  const findings = [];
  const commands = [];

  if (!exists) findings.push({ id: 'project-path-missing', severity: 'blocker', message: 'Project path does not exist.' });
  if (exists && !isDirectory) findings.push({ id: 'project-path-not-directory', severity: 'blocker', message: 'Project path must be a directory.' });
  if (pathHasUnsafeActiveSource(projectPath)) {
    findings.push({
      id: 'project-path-needs-localization',
      severity: 'blocker',
      message: 'Project path routes through OneDrive or Downloads and must be copied to a local workspace before import.',
    });
  }

  const detectedFiles = isDirectory ? detectProjectFiles(projectPath) : [];
  if (isDirectory && detectedFiles.length === 0) {
    findings.push({
      id: 'weak-project-context',
      severity: 'warn',
      message: 'No README, package, or agent instruction file was detected; importer will have weak context.',
    });
  }

  if (findings.every((finding) => finding.severity !== 'blocker')) {
    commands.push({
      id: 'draft-import',
      command: `node bin\\meridian.js import-history upload-project "${projectPath}" --project ${stagingProject} -y`,
      expectedEffect: 'Imports repository evidence as draft history evidence and draft project reconstruction only.',
    });
    commands.push({
      id: 'review-draft-reconstruction',
      command: `node bin\\meridian.js browse ${stagingProject} --category project-reconstruction`,
      expectedEffect: 'Human reviews imported reconstruction before any promotion.',
    });
    commands.push({
      id: 'promotion-ledger-plan',
      command: `node bin\\meridian.js knowledge rollback-plan analysis-${targetProject} --project ${stagingProject} --json`,
      expectedEffect: 'Shows recoverability posture before any future promotion.',
    });
  }

  return {
    schemaVersion: PLAN_SCHEMA,
    generatedAt: opts.now || new Date().toISOString(),
    ok: findings.every((finding) => finding.severity !== 'blocker'),
    status: findings.some((finding) => finding.severity === 'blocker')
      ? 'blocked'
      : findings.length
        ? 'ready_with_warnings'
        : 'ready',
    projectPath,
    projectName,
    stagingProject,
    targetProject,
    detectedFiles,
    safety: {
      importTrustState: 'draft',
      initialPartition: 'candidate_basin',
      automaticPromotionAllowed: false,
      requiredReviewBeforePromotion: true,
      ignoredPaths: SAFE_IGNORES,
    },
    commands,
    findings,
  };
}

module.exports = {
  PLAN_SCHEMA,
  SAFE_IGNORES,
  buildProjectImportPlan,
  pathHasUnsafeActiveSource,
};
