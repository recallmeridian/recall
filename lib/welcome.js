'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const historyImport = require('./history-import');
const { buildProjectImportPlan, pathHasUnsafeActiveSource } = require('./project-import-workflow');

const WELCOME_SCHEMA = 'recall_welcome/v1';
const ORGANIZATION_PACKET_SCHEMA = 'recall_welcome_organization_packet/v1';
const ORGANIZATION_DECISIONS = new Set([
  'keep',
  'rename',
  'defer',
  'needs_more_context',
  'promote',
]);

const AI_SOURCE_HELP = [
  {
    source: 'claude-ai',
    label: 'Claude.ai export',
    command: 'recall import-history import --source claude-ai --path <conversations.json>',
    note: 'Use the exported conversations.json file after placing it in a local non-Downloads workspace.',
  },
  {
    source: 'codex',
    label: 'Codex sessions',
    command: 'recall import-history import --source codex --path <sessions-directory>',
    note: 'Use a local JSONL session directory discovered by scan or supplied by the user.',
  },
  {
    source: 'claude-code',
    label: 'Claude Code sessions',
    command: 'recall import-history import --source claude-code --path <sessions-directory>',
    note: 'Use a local JSONL session directory, commonly under the user profile .claude area.',
  },
  {
    source: 'gemini-cli',
    label: 'Gemini CLI saved chats',
    command: 'recall import-history import --source codex --path <future-gemini-adapter-input>',
    note: 'Adapter pending; welcome should ask users for exported/saved chat files rather than assuming a stable vendor path.',
    status: 'adapter-needed',
  },
  {
    source: 'chatgpt',
    label: 'ChatGPT export',
    command: 'recall import-history import --source claude-ai --path <future-chatgpt-adapter-input>',
    note: 'Adapter pending; ChatGPT data exports need their own parser before treating conversations as structured evidence.',
    status: 'adapter-needed',
  },
];

function now() {
  return new Date().toISOString();
}

function overallStatus(checks) {
  if (checks.some((check) => check.severity === 'blocker')) return 'blocked';
  if (checks.some((check) => check.severity === 'warn')) return 'ready_with_warnings';
  return 'ready';
}

function makeCheck(id, severity, title, details = {}) {
  return {
    id,
    severity,
    title,
    ...details,
  };
}

function canWriteDataDir(dataDir) {
  const absolute = path.resolve(dataDir);
  fs.mkdirSync(absolute, { recursive: true });
  const probe = path.join(absolute, `.welcome-write-check-${process.pid}-${Date.now()}`);
  fs.writeFileSync(probe, 'ok');
  fs.unlinkSync(probe);
  return absolute;
}

function resolveCommand(name, opts = {}) {
  if (opts.commandResolver) return opts.commandResolver(name);
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    return childProcess.execFileSync(command, [name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function classifyToolResolution(name, resolved, opts = {}) {
  const expectedBin = path.resolve(opts.expectedToolBin || path.join(os.homedir(), 'Desktop', 'tools', 'bin'));
  if (resolved.length === 0) {
    return makeCheck(`tool-${name}-missing`, 'warn', `${name} was not found on PATH.`, {
      remediation: `Install ${name} or provide an explicit local tool path before relying on scripted onboarding.`,
    });
  }

  const first = path.resolve(resolved[0]);
  const lower = first.toLowerCase();
  const expected = expectedBin.toLowerCase();
  const allowedNpmShim = lower.endsWith(`${path.sep}npm${path.sep}${name}.cmd`)
    || lower.endsWith(`${path.sep}npm${path.sep}${name}.ps1`);

  if (lower.startsWith(expected) || allowedNpmShim) {
    return makeCheck(`tool-${name}-local`, 'ok', `${name} resolves through a local tool path.`, {
      path: first,
    });
  }

  return makeCheck(`tool-${name}-path-drift`, 'warn', `${name} resolves outside the preferred local tools bin.`, {
    path: first,
    expectedPrefix: expectedBin,
    remediation: `Put ${expectedBin} before bundled app aliases and app-store shims in PATH.`,
  });
}

function buildWelcomeDoctor(opts = {}) {
  const cwd = path.resolve(opts.cwd || process.cwd());
  const dataDir = path.resolve(opts.dataDir || opts.getDataDir && opts.getDataDir() || path.join(os.homedir(), '.meridian'));
  const checks = [];

  if (pathHasUnsafeActiveSource(cwd)) {
    checks.push(makeCheck('workspace-needs-localization', 'blocker', 'The active workspace routes through OneDrive or Downloads.', {
      path: cwd,
      remediation: 'Copy the checkout to a local workspace such as Desktop/recall-cli before continuing.',
    }));
  } else {
    checks.push(makeCheck('workspace-local', 'ok', 'The active workspace is local.', { path: cwd }));
  }

  if (pathHasUnsafeActiveSource(dataDir)) {
    checks.push(makeCheck('data-dir-needs-localization', 'blocker', 'Recall data directory routes through OneDrive or Downloads.', {
      path: dataDir,
      remediation: 'Set MERIDIAN_DATA to a local non-OneDrive directory.',
    }));
  } else {
    try {
      checks.push(makeCheck('data-dir-writable', 'ok', 'Recall data directory is writable.', {
        path: canWriteDataDir(dataDir),
      }));
    } catch (err) {
      checks.push(makeCheck('data-dir-unwritable', 'blocker', 'Recall data directory is not writable.', {
        path: dataDir,
        error: err.message,
        remediation: 'Create the directory or set MERIDIAN_DATA to a writable local folder.',
      }));
    }
  }

  checks.push(classifyToolResolution('rg', resolveCommand('rg', opts), opts));
  checks.push(classifyToolResolution('git', resolveCommand('git', opts), opts));

  return {
    schemaVersion: WELCOME_SCHEMA,
    kind: 'doctor',
    generatedAt: opts.now || now(),
    status: overallStatus(checks),
    checks,
  };
}

function buildWelcomeDiscovery(opts = {}) {
  const roots = (opts.roots && opts.roots.length > 0)
    ? opts.roots.map((root) => path.resolve(root))
    : [os.homedir()].filter(Boolean);
  const discoveredSources = historyImport.scanSources({ roots });
  const projectRoots = [];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const repos = historyImport.findGitRepos(root, { maxDepth: Number.isInteger(opts.maxDepth) ? opts.maxDepth : 4 });
    for (const repo of repos) projectRoots.push(repo);
  }

  const sources = discoveredSources.map((source) => ({
    ...source,
    unsafeActiveSource: pathHasUnsafeActiveSource(source.path),
    recommendedCommand: source.source === 'repo'
      ? `recall import-history project-plan "${source.path}"`
      : `recall import-history import --source ${source.source} --path "${source.path}"`,
  }));

  const projects = Array.from(new Set(projectRoots)).sort().map((repoPath) => ({
    path: repoPath,
    unsafeActiveSource: pathHasUnsafeActiveSource(repoPath),
    planCommand: `recall welcome plan "${repoPath}"`,
  }));

  return {
    schemaVersion: WELCOME_SCHEMA,
    kind: 'discovery',
    generatedAt: opts.now || now(),
    roots,
    status: sources.length || projects.length ? 'found_sources' : 'needs_manual_paths',
    sources,
    projects,
    adapters: AI_SOURCE_HELP,
  };
}

function buildWelcomeProjectPlan(projectPath, opts = {}) {
  const plan = buildProjectImportPlan({
    path: projectPath,
    stagingProject: opts.project || historyImport.DEFAULT_PROJECT,
    targetProject: opts.targetProject,
  }, {
    now: opts.now,
  });

  const nextSteps = plan.ok
    ? [
      {
        id: 'run-draft-import',
        title: 'Stage the project as draft evidence.',
        command: plan.commands.find((command) => command.id === 'draft-import').command,
      },
      {
        id: 'review-reconstruction',
        title: 'Review the reconstructed project before trusting it.',
        command: plan.commands.find((command) => command.id === 'review-draft-reconstruction').command,
      },
      {
        id: 'ask-recall-next-actions',
        title: 'After review, search for decisions, TODOs, and next actions.',
        command: `recall search ${plan.stagingProject} "next todo decision blocked ${plan.targetProject}"`,
      },
    ]
    : [];

  return {
    schemaVersion: WELCOME_SCHEMA,
    kind: 'project-plan',
    generatedAt: opts.now || now(),
    status: plan.status,
    plan,
    welcomeSafety: {
      automaticPromotionAllowed: false,
      userReviewRequired: true,
      importedEvidenceStartsAs: 'draft project reconstruction',
    },
    nextSteps,
  };
}

function getProjectReconstructions(kb, projectId) {
  return kb.listEntries(projectId, { category: 'project-reconstruction' })
    .filter((entry) => entry && entry._extensions && entry._extensions.historyImportType === 'analysis')
    .map((entry) => {
      const summary = entry._extensions.summary || {};
      return {
        id: entry.id,
        name: entry.name || `Project reconstruction: ${summary.projectName || summary.projectKey || 'unknown'}`,
        status: entry.status || 'draft',
        promotionState: entry._extensions.promotionState || 'review',
        projectKey: summary.projectKey || entry.id.replace(/^analysis-/, ''),
        projectName: summary.projectName || summary.projectKey || entry.name || '',
        evidenceCount: Number(summary.evidenceCount || 0),
        sources: Array.isArray(summary.sources) ? summary.sources : [],
        kinds: Array.isArray(summary.kinds) ? summary.kinds : [],
        topKeywords: Array.isArray(summary.topKeywords) ? summary.topKeywords : [],
        likelyTodos: Array.isArray(summary.likelyTodos) ? summary.likelyTodos : [],
        likelyDecisions: Array.isArray(summary.likelyDecisions) ? summary.likelyDecisions : [],
        evidenceIds: Array.isArray(summary.evidenceIds) ? summary.evidenceIds : [],
      };
    })
    .sort((left, right) => right.evidenceCount - left.evidenceCount || left.projectKey.localeCompare(right.projectKey));
}

function reviewRecommendation(reconstruction) {
  if (reconstruction.status !== 'draft') {
    return 'Already promoted or otherwise non-draft; audit before changing.';
  }
  if (reconstruction.evidenceCount < 2) {
    return 'Needs more evidence before promotion.';
  }
  if (reconstruction.likelyTodos.length || reconstruction.likelyDecisions.length) {
    return 'Ready for human review; confirm project identity and next actions.';
  }
  return 'Review project identity, then import more sessions if the reconstruction feels thin.';
}

function buildWelcomeReview(kb, opts = {}) {
  const projectId = opts.project || historyImport.DEFAULT_PROJECT;
  const reconstructions = getProjectReconstructions(kb, projectId)
    .map((reconstruction) => ({
      ...reconstruction,
      recommendation: reviewRecommendation(reconstruction),
      reviewCommands: {
        browse: `recall browse ${projectId} --category project-reconstruction`,
        searchTodos: `recall search ${projectId} "todo next follow-up ${reconstruction.projectKey}"`,
        searchDecisions: `recall search ${projectId} "decision decided chosen ${reconstruction.projectKey}"`,
        promoteAfterReview: `recall import-history promote ${reconstruction.id}`,
      },
    }));

  return {
    schemaVersion: WELCOME_SCHEMA,
    kind: 'review',
    generatedAt: opts.now || now(),
    project: projectId,
    status: reconstructions.length ? 'ready_for_review' : 'no_reconstructions',
    safety: {
      automaticPromotionAllowed: false,
      requiredReviewBeforePromotion: true,
    },
    reconstructions,
    emptyState: reconstructions.length ? null : {
      message: 'No project reconstructions found yet.',
      nextCommands: [
        'recall welcome discover --root <local-projects-folder>',
        'recall welcome plan <project-path>',
        'recall import-history upload-project <project-path>',
        `recall import-history analyze --project ${projectId}`,
      ],
    },
  };
}

function priorityForAction(kind, reconstruction) {
  if (kind === 'review_project_identity') return 'high';
  if (kind === 'resolve_blockers' && reconstruction.likelyTodos.some((line) => /\b(blocked|blocker|failed|failing|error)\b/i.test(line))) return 'high';
  if (kind === 'review_decisions' && reconstruction.likelyDecisions.length) return 'medium';
  if (kind === 'import_more_context') return reconstruction.evidenceCount < 2 ? 'high' : 'low';
  return 'medium';
}

function makeAction(id, kind, reconstruction, fields = {}) {
  return {
    id,
    schemaVersion: 'recall_welcome_action/v1',
    project: reconstruction.projectKey,
    reconstructionId: reconstruction.id,
    kind,
    priority: priorityForAction(kind, reconstruction),
    status: 'proposed',
    automationAllowed: false,
    evidenceRefs: reconstruction.evidenceIds.slice(0, 8).map((entryId) => ({
      type: 'history-evidence',
      project: historyImport.DEFAULT_PROJECT,
      entryId,
    })),
    ...fields,
  };
}

function buildActionsForReconstruction(reconstruction, opts = {}) {
  const projectId = opts.project || historyImport.DEFAULT_PROJECT;
  const slug = reconstruction.projectKey;
  const actions = [
    makeAction(`welcome-${slug}-review-identity`, 'review_project_identity', reconstruction, {
      title: `Confirm the "${reconstruction.projectName}" project reconstruction.`,
      reason: `Recall grouped ${reconstruction.evidenceCount} imported evidence record(s) from ${reconstruction.sources.join(', ') || 'unknown sources'}.`,
      command: `recall browse ${projectId} --category project-reconstruction`,
      validationMethod: 'User confirms, renames, splits, or defers the reconstruction before promotion.',
    }),
  ];

  if (reconstruction.likelyTodos.length) {
    actions.push(makeAction(`welcome-${slug}-resolve-todos`, 'resolve_blockers', reconstruction, {
      title: `Review ${Math.min(reconstruction.likelyTodos.length, 12)} possible next-step line(s).`,
      reason: 'Imported sessions mention TODO, next, follow-up, fix, implement, add, or need-to language.',
      command: `recall search ${projectId} "todo next follow-up fix implement ${slug}"`,
      sampleEvidence: reconstruction.likelyTodos.slice(0, 5),
      validationMethod: 'User marks which candidate lines are real next actions for the project.',
    }));
  }

  if (reconstruction.likelyDecisions.length) {
    actions.push(makeAction(`welcome-${slug}-review-decisions`, 'review_decisions', reconstruction, {
      title: `Review ${Math.min(reconstruction.likelyDecisions.length, 12)} possible decision line(s).`,
      reason: 'Imported sessions mention decisions, chosen paths, or settled implementation choices.',
      command: `recall search ${projectId} "decision decided chosen settled ${slug}"`,
      sampleEvidence: reconstruction.likelyDecisions.slice(0, 5),
      validationMethod: 'User confirms which decisions should become durable project memory.',
    }));
  }

  if (reconstruction.evidenceCount < 2 || reconstruction.sources.length < 2) {
    actions.push(makeAction(`welcome-${slug}-import-more-context`, 'import_more_context', reconstruction, {
      title: `Import more context for "${reconstruction.projectName}".`,
      reason: 'The reconstruction is based on limited evidence or a single source type.',
      command: 'recall welcome discover --root <local-projects-folder>',
      validationMethod: 'User imports another repo, export, or session folder before promotion.',
    }));
  }

  return actions;
}

function buildWelcomeActions(kb, opts = {}) {
  const projectId = opts.project || historyImport.DEFAULT_PROJECT;
  const reconstructions = getProjectReconstructions(kb, projectId);
  const actions = reconstructions.flatMap((reconstruction) => buildActionsForReconstruction(reconstruction, {
    project: projectId,
  })).sort((left, right) => {
    const rank = { high: 0, medium: 1, low: 2 };
    return (rank[left.priority] ?? 3) - (rank[right.priority] ?? 3)
      || left.project.localeCompare(right.project)
      || left.kind.localeCompare(right.kind);
  });

  return {
    schemaVersion: WELCOME_SCHEMA,
    kind: 'actions',
    generatedAt: opts.now || now(),
    project: projectId,
    status: actions.length ? 'proposed_actions' : 'no_actions',
    automationAllowed: false,
    actions,
    emptyState: actions.length ? null : {
      message: 'No welcome actions are available because no draft project reconstructions were found.',
      nextCommands: [
        'recall import-history analyze',
        `recall welcome review --project ${projectId}`,
      ],
    },
  };
}

function buildWelcomeOrganizationPacket(kb, opts = {}) {
  const projectId = opts.project || historyImport.DEFAULT_PROJECT;
  const reconstructions = getProjectReconstructions(kb, projectId);
  return {
    schemaVersion: ORGANIZATION_PACKET_SCHEMA,
    generatedAt: opts.now || now(),
    project: projectId,
    status: reconstructions.length ? 'editable' : 'empty',
    instructions: [
      'Edit each decision to one of: keep, rename, defer, needs_more_context, promote.',
      'Use rename with newProjectName when Recall identified the right project under the wrong name.',
      'Use defer or needs_more_context when evidence is too thin or noisy.',
      'Use promote only after human review; set reviewConfirmed=true.',
      'Merge and split are intentionally not applied by this packet yet; keep separate notes for those cases.',
    ],
    supportedDecisions: Array.from(ORGANIZATION_DECISIONS),
    unsupportedFutureDecisions: ['merge', 'split'],
    decisions: reconstructions.map((reconstruction) => ({
      reconstructionId: reconstruction.id,
      currentProjectKey: reconstruction.projectKey,
      currentProjectName: reconstruction.projectName,
      evidenceCount: reconstruction.evidenceCount,
      sources: reconstruction.sources,
      likelyTodos: reconstruction.likelyTodos.slice(0, 5),
      likelyDecisions: reconstruction.likelyDecisions.slice(0, 5),
      decision: reconstruction.evidenceCount < 2 ? 'needs_more_context' : 'keep',
      newProjectName: '',
      reviewConfirmed: false,
      notes: '',
    })),
  };
}

function validateWelcomeOrganizationPacket(packet = {}) {
  const issues = [];
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
    return {
      ok: false,
      status: 'invalid',
      issues: ['packet_must_be_object'],
    };
  }
  if (packet.schemaVersion !== ORGANIZATION_PACKET_SCHEMA) issues.push('schema_mismatch');
  if (!packet.project) issues.push('missing_project');
  if (!Array.isArray(packet.decisions)) issues.push('missing_decisions');

  const seen = new Set();
  for (const [index, decision] of (Array.isArray(packet.decisions) ? packet.decisions : []).entries()) {
    const prefix = `decisions[${index}]`;
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
      issues.push(`${prefix}.must_be_object`);
      continue;
    }
    if (!decision.reconstructionId) issues.push(`${prefix}.missing_reconstruction_id`);
    if (decision.reconstructionId && seen.has(decision.reconstructionId)) issues.push(`${prefix}.duplicate_reconstruction_id`);
    if (decision.reconstructionId) seen.add(decision.reconstructionId);
    if (!ORGANIZATION_DECISIONS.has(decision.decision)) issues.push(`${prefix}.unsupported_decision:${decision.decision || ''}`);
    if (decision.decision === 'rename' && !String(decision.newProjectName || '').trim()) {
      issues.push(`${prefix}.rename_requires_new_project_name`);
    }
    if (decision.decision === 'promote' && decision.reviewConfirmed !== true) {
      issues.push(`${prefix}.promote_requires_review_confirmed`);
    }
  }

  return {
    ok: issues.length === 0,
    status: issues.length ? 'invalid' : 'valid',
    issues,
  };
}

function organizationDecisionPatch(entry, decision, context = {}) {
  const ext = entry._extensions || {};
  const summary = ext.summary || {};
  const organizationRecord = {
    decision: decision.decision,
    decidedAt: context.now || now(),
    notes: decision.notes || '',
    reviewConfirmed: decision.reviewConfirmed === true,
  };

  if (decision.decision === 'rename') {
    const newProjectName = String(decision.newProjectName || '').trim();
    return {
      name: `Project reconstruction: ${newProjectName}`,
      _extensions: {
        ...ext,
        promotionState: 'review',
        summary: {
          ...summary,
          projectName: newProjectName,
        },
        welcomeOrganization: organizationRecord,
      },
    };
  }

  if (decision.decision === 'defer') {
    return {
      status: 'draft',
      _extensions: {
        ...ext,
        promotionState: 'deferred',
        welcomeOrganization: organizationRecord,
      },
    };
  }

  if (decision.decision === 'needs_more_context') {
    return {
      status: 'draft',
      _extensions: {
        ...ext,
        promotionState: 'needs_more_context',
        welcomeOrganization: organizationRecord,
      },
    };
  }

  return {
    status: 'draft',
    _extensions: {
      ...ext,
      promotionState: 'review_confirmed',
      welcomeOrganization: organizationRecord,
    },
  };
}

function applyWelcomeOrganizationPacket(kb, packet = {}, opts = {}) {
  const validation = validateWelcomeOrganizationPacket(packet);
  if (!validation.ok) {
    const err = new Error(`Welcome organization packet is invalid: ${validation.issues.join(', ')}`);
    err.validation = validation;
    throw err;
  }

  const projectId = packet.project;
  const results = [];
  for (const decision of packet.decisions) {
    const entry = kb.getEntry(projectId, decision.reconstructionId);
    const ext = entry._extensions || {};
    if (ext.historyImportType !== 'analysis') {
      throw new Error(`Entry "${decision.reconstructionId}" is not a project reconstruction analysis.`);
    }

    if (decision.decision === 'promote') {
      const promoted = historyImport.promoteAnalysis(kb, projectId, decision.reconstructionId);
      results.push({
        reconstructionId: decision.reconstructionId,
        decision: decision.decision,
        status: promoted.status,
        promotionState: promoted._extensions && promoted._extensions.promotionState,
      });
      continue;
    }

    const updated = kb.updateEntry(projectId, decision.reconstructionId, organizationDecisionPatch(entry, decision, {
      now: opts.now,
    }));
    results.push({
      reconstructionId: decision.reconstructionId,
      decision: decision.decision,
      status: updated.status,
      name: updated.name,
      promotionState: updated._extensions && updated._extensions.promotionState,
    });
  }

  return {
    schemaVersion: WELCOME_SCHEMA,
    kind: 'organize-apply',
    generatedAt: opts.now || now(),
    project: projectId,
    status: 'applied',
    appliedCount: results.length,
    results,
  };
}

function buildWelcomeGuide(opts = {}) {
  return {
    schemaVersion: WELCOME_SCHEMA,
    kind: 'guide',
    generatedAt: opts.now || now(),
    status: 'ready',
    phases: [
      {
        id: 'doctor',
        title: 'Check the local setup.',
        command: 'recall welcome doctor',
        outcome: 'Confirms Recall can write local data and that tools resolve from safe local paths.',
      },
      {
        id: 'discover',
        title: 'Find project and AI-session sources.',
        command: 'recall welcome discover --root <local-projects-folder>',
        outcome: 'Lists likely repos, Claude/Codex history, and adapters that still need explicit exports.',
      },
      {
        id: 'plan',
        title: 'Create a draft-only import plan.',
        command: 'recall welcome plan <project-path>',
        outcome: 'Shows safety findings and exact commands before Recall reads project history.',
      },
      {
        id: 'organize',
        title: 'Correct the project map.',
        command: 'recall welcome organize',
        outcome: 'Creates an editable packet for keeping, renaming, deferring, or promoting reconstructions.',
      },
      {
        id: 'review',
        title: 'Review before promotion.',
        command: 'recall welcome review',
        outcome: 'Lets the user confirm, rename, split, or defer reconstructed project memory.',
      },
      {
        id: 'act',
        title: 'Use the recovered work.',
        command: 'recall welcome actions',
        outcome: 'Surfaces project-specific next actions from staged evidence.',
      },
    ],
  };
}

module.exports = {
  WELCOME_SCHEMA,
  ORGANIZATION_PACKET_SCHEMA,
  AI_SOURCE_HELP,
  buildWelcomeDoctor,
  buildWelcomeDiscovery,
  buildWelcomeProjectPlan,
  buildWelcomeReview,
  buildWelcomeActions,
  buildWelcomeOrganizationPacket,
  validateWelcomeOrganizationPacket,
  applyWelcomeOrganizationPacket,
  buildWelcomeGuide,
};
