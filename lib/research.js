'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PROJECT = 'erdos-vibe';
const WORKFLOW_STEPS = [
  {
    id: 'find-problem',
    title: 'Find candidate open problem',
    description: 'Identify a narrow open problem with a trustworthy source.',
  },
  {
    id: 'create-problem',
    title: 'Create Recall research problem',
    description: 'Store the exact statement, source, tags, and current status.',
  },
  {
    id: 'build-corpus',
    title: 'Build surrounding corpus',
    description: 'Collect relevant papers, books, notes, definitions, and known partial results.',
  },
  {
    id: 'generate-attempts',
    title: 'Generate attempts',
    description: 'Create proof paths, reductions, simulations, counterexample searches, or lemma chains.',
  },
  {
    id: 'verify',
    title: 'Verify what can be verified',
    description: 'Use Lean, scripts, simulations, literature checks, or expert review.',
  },
  {
    id: 'ingest-traces',
    title: 'Ingest attempt traces',
    description: 'Store successful, failed, partial, and drift-suspected traces as evidence.',
  },
  {
    id: 'map-dead-ends',
    title: 'Map dead ends',
    description: 'Classify failed approaches so the system avoids repeating them.',
  },
  {
    id: 'promote-progress',
    title: 'Promote verified progress',
    description: 'Promote only verified lemmas, counterexamples, bounds, or clear progress.',
  },
];

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function now() {
  return new Date().toISOString();
}

function confidence(value, verificationStatus = 'unverified', exempt = false) {
  return {
    value,
    lastVerified: now(),
    decayDays: exempt ? 0 : 90,
    exempt,
    verificationStatus,
  };
}

function baseEntry(projectId, fields) {
  return {
    schemaVersion: '4.0',
    projectId,
    practicalValue: fields.practicalValue || 'medium',
    fusion: { fusedFrom: [], fusedAt: null, fusionDepth: 0 },
    confidence: fields.confidence || confidence(0.5),
    tags: fields.tags || [],
    source: fields.source || 'research-port',
    ...fields,
  };
}

function ensureProject(kb, projectId = DEFAULT_PROJECT) {
  const projects = kb.listProjects();
  const existing = projects.find((p) => p.id === projectId);
  if (existing) return existing;
  return kb.createProject({
    id: projectId,
    name: projectId,
    description: 'Research attempts, verifier traces, dead ends, and promotions.',
  });
}

function problemEntry(projectId, input) {
  const title = input.title || input.id;
  const id = input.id || `problem-${slugify(title)}`;
  const tags = ['research-problem', ...(input.tags || [])];
  return baseEntry(projectId, {
    id: slugify(id),
    name: title,
    description: input.statement || input.description || title,
    category: 'research-problem',
    status: 'draft',
    sourceUrl: input.sourceUrl || undefined,
    practicalValue: 'high',
    confidence: confidence(0.45, 'unverified', false),
    tags,
    _extensions: {
      researchType: 'problem',
      lifecycle: 'candidate',
      domain: input.domain || 'math',
      problemId: id,
      formalStatement: input.formalStatement || '',
      informalStatement: input.statement || '',
      sourceRef: input.sourceRef || '',
      driftStatus: 'unchecked',
      workflow: initialWorkflow(),
    },
  });
}

function initialWorkflow() {
  return WORKFLOW_STEPS.map((step, index) => ({
    ...step,
    status: index === 0 ? 'in_progress' : 'pending',
    completedAt: null,
    notes: '',
  }));
}

function addProblem(kb, projectId, input) {
  ensureProject(kb, projectId);
  return kb.addEntry(projectId, problemEntry(projectId, input));
}

function parseJsonlTrace(tracePath) {
  const absolutePath = path.resolve(tracePath);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const parsed = [];
  const parseErrors = [];

  lines.forEach((line, index) => {
    try {
      parsed.push(JSON.parse(line));
    } catch (err) {
      parseErrors.push({ line: index + 1, message: err.message });
    }
  });

  const leanErrors = [];
  const tactics = [];
  const lemmas = new Set();

  for (const item of parsed) {
    const text = JSON.stringify(item);
    if (/error|exception|failed/i.test(text)) {
      leanErrors.push(item);
    }
    for (const key of ['tactic', 'proposed_tactic', 'selected_tactic']) {
      if (typeof item[key] === 'string') tactics.push(item[key]);
    }
    for (const key of ['lemma', 'premise', 'premises', 'lemmas_used']) {
      const value = item[key];
      if (typeof value === 'string') lemmas.add(value);
      if (Array.isArray(value)) value.forEach((v) => lemmas.add(String(v)));
    }
  }

  return {
    absolutePath,
    hash,
    lineCount: lines.length,
    parsedCount: parsed.length,
    parseErrors,
    leanErrorCount: leanErrors.length,
    tacticCount: tactics.length,
    tactics: tactics.slice(0, 50),
    lemmas: Array.from(lemmas).slice(0, 100),
  };
}

function attemptEntry(projectId, input, traceSummary) {
  const status = input.status || 'partial';
  const title = input.title || `Attempt for ${input.problemId}`;
  const attemptId = input.id || `attempt-${slugify(input.problemId)}-${Date.now()}`;
  const isVerified = status === 'verified';
  const isFailed = status === 'failed';
  const tags = [
    'research-attempt',
    `adapter:${input.adapter || 'external'}`,
    `verifier:${input.verifier || 'unknown'}`,
    `attempt-status:${status}`,
  ];

  return baseEntry(projectId, {
    id: slugify(attemptId),
    name: title,
    description: input.summary || `Research attempt for ${input.problemId} via ${input.adapter || 'external adapter'}.`,
    category: isFailed ? 'research-dead-end' : 'research-attempt',
    status: isVerified ? 'active' : 'draft',
    practicalValue: isVerified ? 'high' : 'medium',
    confidence: confidence(isVerified ? 0.95 : isFailed ? 0.35 : 0.55, isVerified ? 'verified' : 'unverified', false),
    tags,
    _extensions: {
      researchType: 'attempt',
      lifecycle: isVerified ? 'validated' : isFailed ? 'dead_end' : 'candidate',
      parentProblemId: input.problemId,
      adapter: input.adapter || 'external',
      verifier: input.verifier || '',
      verifierVersion: input.verifierVersion || '',
      attemptStatus: status,
      trace: traceSummary,
      artifactPath: input.artifactPath ? path.resolve(input.artifactPath) : '',
      failureReason: input.failureReason || '',
      driftStatus: input.driftStatus || 'unchecked',
      notes: input.notes || '',
    },
  });
}

function ingestTrace(kb, projectId, input) {
  ensureProject(kb, projectId);
  const traceSummary = parseJsonlTrace(input.tracePath);
  const entry = kb.addEntry(projectId, attemptEntry(projectId, input, traceSummary));

  if (input.problemId) {
    try {
      kb.addRelationship(projectId, input.problemId, projectId, entry.id, 'attempted-via');
    } catch (_) {
      // Relationship creation is best-effort because older problem IDs may not
      // be entry IDs yet; the extension metadata still preserves the link.
    }
  }

  return entry;
}

function listResearchEntries(kb, projectId) {
  ensureProject(kb, projectId);
  return kb.listEntries(projectId).filter((entry) => {
    return entry._extensions && entry._extensions.researchType;
  });
}

function getResearchStatus(kb, projectId) {
  const entries = listResearchEntries(kb, projectId);
  const counts = {
    problems: 0,
    attempts: 0,
    verified: 0,
    failed: 0,
    partial: 0,
    driftSuspected: 0,
  };

  for (const entry of entries) {
    const ext = entry._extensions || {};
    if (ext.researchType === 'problem') counts.problems += 1;
    if (ext.researchType === 'attempt') {
      counts.attempts += 1;
      if (ext.attemptStatus === 'verified') counts.verified += 1;
      else if (ext.attemptStatus === 'failed') counts.failed += 1;
      else counts.partial += 1;
    }
    if (ext.driftStatus === 'drift_suspected') counts.driftSuspected += 1;
  }

  return { counts, entries };
}

function getProblem(kb, projectId, problemId) {
  const entry = kb.getEntry(projectId, problemId);
  const ext = entry._extensions || {};
  if (ext.researchType !== 'problem') {
    throw new Error(`Entry "${problemId}" is not a research problem.`);
  }
  if (!Array.isArray(ext.workflow)) {
    entry._extensions = {
      ...ext,
      workflow: initialWorkflow(),
    };
  }
  return entry;
}

function updateProblemWorkflow(kb, projectId, problemId, workflow) {
  const problem = getProblem(kb, projectId, problemId);
  return kb.updateEntry(projectId, problemId, {
    _extensions: {
      ...problem._extensions,
      workflow,
    },
  });
}

function getWorkflow(kb, projectId, problemId) {
  return getProblem(kb, projectId, problemId)._extensions.workflow;
}

function completeWorkflowStep(kb, projectId, problemId, stepId, notes = '') {
  const workflow = getWorkflow(kb, projectId, problemId).map((step) => ({ ...step }));
  const index = stepId
    ? workflow.findIndex((step) => step.id === stepId)
    : workflow.findIndex((step) => step.status === 'in_progress');

  if (index === -1) {
    throw new Error(stepId ? `Unknown workflow step "${stepId}".` : 'No in-progress workflow step found.');
  }

  workflow[index] = {
    ...workflow[index],
    status: 'done',
    completedAt: now(),
    notes: notes || workflow[index].notes || '',
  };

  const nextIndex = workflow.findIndex((step, i) => i > index && step.status === 'pending');
  if (nextIndex !== -1) {
    workflow[nextIndex] = {
      ...workflow[nextIndex],
      status: 'in_progress',
    };
  }

  const updated = updateProblemWorkflow(kb, projectId, problemId, workflow);
  return {
    problem: updated,
    completed: workflow[index],
    next: nextIndex === -1 ? null : workflow[nextIndex],
  };
}

function setWorkflowStep(kb, projectId, problemId, stepId, status, notes = '') {
  const allowed = new Set(['pending', 'in_progress', 'done', 'blocked']);
  if (!allowed.has(status)) {
    throw new Error(`Invalid workflow status "${status}".`);
  }
  const workflow = getWorkflow(kb, projectId, problemId).map((step) => ({ ...step }));
  const index = workflow.findIndex((step) => step.id === stepId);
  if (index === -1) throw new Error(`Unknown workflow step "${stepId}".`);

  workflow[index] = {
    ...workflow[index],
    status,
    completedAt: status === 'done' ? (workflow[index].completedAt || now()) : null,
    notes: notes || workflow[index].notes || '',
  };

  return updateProblemWorkflow(kb, projectId, problemId, workflow);
}

function promoteAttempt(kb, projectId, attemptId, notes = '') {
  const attempt = kb.getEntry(projectId, attemptId);
  const ext = attempt._extensions || {};
  if (ext.researchType !== 'attempt') {
    throw new Error(`Entry "${attemptId}" is not a research attempt.`);
  }
  if (ext.driftStatus === 'drift_suspected') {
    throw new Error('Cannot promote attempt while statement/formalization drift is suspected.');
  }

  const updated = kb.updateEntry(projectId, attemptId, {
    status: 'active',
    confidence: confidence(0.95, 'verified', false),
    _extensions: {
      ...ext,
      lifecycle: 'validated',
      attemptStatus: 'verified',
      promotedAt: now(),
      promotionNotes: notes,
    },
  });

  if (ext.parentProblemId) {
    try {
      kb.addRelationship(projectId, ext.parentProblemId, projectId, attemptId, 'verified-by');
    } catch (_) {
      // Metadata remains canonical if the relationship endpoint is unavailable.
    }
  }

  return updated;
}

module.exports = {
  DEFAULT_PROJECT,
  WORKFLOW_STEPS,
  ensureProject,
  addProblem,
  ingestTrace,
  parseJsonlTrace,
  getResearchStatus,
  promoteAttempt,
  getWorkflow,
  completeWorkflowStep,
  setWorkflowStep,
  problemEntry,
  attemptEntry,
};
