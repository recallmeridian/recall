'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

const DEFAULT_PROJECT = 'recall-imports';
const KNOWN_SOURCE_PATHS = [
  {
    source: 'claude-ai',
    label: 'Claude.ai export',
    candidates: [
      path.join('Downloads', 'conversations.json'),
      path.join('Desktop', 'conversations.json'),
    ],
  },
  {
    source: 'codex',
    label: 'Codex sessions',
    candidates: [
      path.join('.codex', 'sessions'),
      path.join('.codex', 'history'),
    ],
  },
  {
    source: 'claude-code',
    label: 'Claude Code sessions',
    candidates: [
      path.join('.claude', 'projects'),
      path.join('.claude', 'sessions'),
    ],
  },
];

function now() {
  return new Date().toISOString();
}

function slugify(value) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'history';
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function confidence(value, verificationStatus = 'unverified') {
  return {
    value,
    lastVerified: now(),
    decayDays: 90,
    exempt: false,
    verificationStatus,
  };
}

function ensureProject(kb, projectId = DEFAULT_PROJECT) {
  const existing = kb.listProjects().find((project) => project.id === projectId);
  if (existing) return existing;
  return kb.createProject({
    id: projectId,
    name: projectId,
    description: 'Imported AI chat, coding-session, repository, and document history staged as evidence.',
  });
}

function baseEntry(projectId, fields) {
  return {
    schemaVersion: '4.0',
    projectId,
    status: 'draft',
    practicalValue: 'medium',
    fusion: { fusedFrom: [], fusedAt: null, fusionDepth: 0 },
    confidence: confidence(0.45),
    tags: [],
    source: 'history-import-port',
    ...fields,
  };
}

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || '';
}

function scanSources(opts = {}) {
  const roots = (opts.roots && opts.roots.length > 0) ? opts.roots : [homeDir()].filter(Boolean);
  const discovered = [];

  for (const root of roots) {
    for (const known of KNOWN_SOURCE_PATHS) {
      for (const candidate of known.candidates) {
        const absolutePath = path.resolve(root, candidate);
        if (fs.existsSync(absolutePath)) {
          const stat = fs.statSync(absolutePath);
          discovered.push({
            source: known.source,
            label: known.label,
            path: absolutePath,
            kind: stat.isDirectory() ? 'directory' : 'file',
          });
        }
      }
    }

    const rootPath = path.resolve(root);
    const gitPath = path.join(rootPath, '.git');
    if (fs.existsSync(gitPath)) {
      discovered.push({
        source: 'repo',
        label: 'Git repository',
        path: rootPath,
        kind: 'directory',
      });
    }
  }

  return discovered;
}

function findGitRepos(rootPath, opts = {}) {
  const maxDepth = Number.isInteger(opts.maxDepth) ? opts.maxDepth : 4;
  const absoluteRoot = path.resolve(rootPath);
  const repos = [];
  const stack = [{ dir: absoluteRoot, depth: 0 }];
  const ignored = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.venv', 'venv', '__pycache__']);

  while (stack.length > 0) {
    const current = stack.pop();
    if (fs.existsSync(path.join(current.dir, '.git'))) {
      repos.push(current.dir);
      continue;
    }
    if (current.depth >= maxDepth) continue;

    let items = [];
    try {
      items = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const item of items) {
      if (!item.isDirectory() || ignored.has(item.name)) continue;
      stack.push({ dir: path.join(current.dir, item.name), depth: current.depth + 1 });
    }
  }

  return repos.sort();
}

function parseClaudeAiExport(filePath) {
  const absolutePath = path.resolve(filePath);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  const parsed = JSON.parse(raw);
  const conversations = Array.isArray(parsed) ? parsed : parsed.conversations || [];

  return conversations.map((conversation, index) => {
    const messages = conversation.chat_messages || conversation.messages || [];
    const title = conversation.name || conversation.title || `Claude.ai conversation ${index + 1}`;
    const text = messages.map((message) => {
      const sender = message.sender || message.role || 'unknown';
      const content = typeof message.text === 'string'
        ? message.text
        : typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content || '');
      return `${sender}: ${content}`;
    }).join('\n');

    return normalizeRecord({
      source: 'claude-ai',
      kind: 'ai_chat',
      sourcePath: absolutePath,
      nativeId: conversation.uuid || conversation.id || `${index}`,
      title,
      timestamp: conversation.created_at || conversation.createdAt || conversation.updated_at || conversation.updatedAt || '',
      text,
      messageCount: messages.length,
    });
  });
}

function parseJsonlSessions(inputPath, source = 'codex') {
  const files = listFiles(inputPath, ['.jsonl']);
  const records = [];

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    const parsed = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line));
      } catch (_) {
        // Keep malformed lines out of structured extraction, but preserve counts.
      }
    }
    const text = parsed.map((item) => JSON.stringify(item)).join('\n');
    records.push(normalizeRecord({
      source,
      kind: 'coding_session',
      sourcePath: file,
      nativeId: path.basename(file, path.extname(file)),
      title: `${source} session ${path.basename(file)}`,
      timestamp: inferTimestampFromFile(file),
      text,
      messageCount: parsed.length,
      parseErrorCount: Math.max(0, lines.length - parsed.length),
    }));
  }

  return records;
}

function inspectGitRepo(repoPath) {
  const absolutePath = path.resolve(repoPath);
  const projectName = path.basename(absolutePath);
  const readIfExists = (name) => {
    const file = path.join(absolutePath, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').slice(0, 12000) : '';
  };

  let remote = '';
  let recentCommits = '';
  try {
    remote = childProcess.execFileSync('git', ['-C', absolutePath, 'remote', '-v'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch (_) {}
  try {
    recentCommits = childProcess.execFileSync('git', ['-C', absolutePath, 'log', '--oneline', '-n', '20'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch (_) {}

  const text = [
    `Repository: ${projectName}`,
    remote && `Remotes:\n${remote}`,
    readIfExists('README.md'),
    readIfExists('package.json'),
    recentCommits && `Recent commits:\n${recentCommits}`,
  ].filter(Boolean).join('\n\n');

  return [normalizeRecord({
    source: 'repo',
    kind: 'repository_snapshot',
    sourcePath: absolutePath,
    nativeId: absolutePath,
    title: `Repository snapshot: ${projectName}`,
    timestamp: now(),
    text,
    repoPath: absolutePath,
    projectHint: projectName,
  })];
}

function listFiles(inputPath, extensions) {
  const absolutePath = path.resolve(inputPath);
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) return extensions.includes(path.extname(absolutePath).toLowerCase()) ? [absolutePath] : [];

  const results = [];
  const stack = [absolutePath];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const itemPath = path.join(current, item.name);
      if (item.isDirectory()) stack.push(itemPath);
      if (item.isFile() && extensions.includes(path.extname(item.name).toLowerCase())) {
        results.push(itemPath);
      }
    }
  }
  return results;
}

function inferTimestampFromFile(filePath) {
  const stat = fs.statSync(filePath);
  return stat.mtime.toISOString();
}

function normalizeRecord(input) {
  const text = String(input.text || '');
  const hash = sha256([
    input.source,
    input.kind,
    input.nativeId,
    input.sourcePath,
    text,
  ].join('\n'));

  return {
    source: input.source,
    kind: input.kind,
    sourcePath: input.sourcePath,
    nativeId: input.nativeId || hash.slice(0, 12),
    title: input.title || `${input.source} ${input.kind}`,
    timestamp: input.timestamp || '',
    text,
    textPreview: text.slice(0, 1000),
    hash,
    projectHint: input.projectHint || inferProjectHint(input, text),
    repoPath: input.repoPath || inferRepoPath(text),
    messageCount: input.messageCount || 0,
    parseErrorCount: input.parseErrorCount || 0,
    keywords: extractKeywords(text),
    todos: extractTodos(text),
    decisions: extractDecisions(text),
  };
}

function inferProjectHint(input, text) {
  if (input.projectHint) return input.projectHint;
  const fromPath = input.sourcePath ? path.basename(path.dirname(input.sourcePath)) : '';
  const packageMatch = text.match(/"name"\s*:\s*"([^"]+)"/);
  if (packageMatch) return packageMatch[1].replace(/^@[^/]+\//, '');
  return fromPath || 'uncategorized';
}

function inferRepoPath(text) {
  const match = text.match(/[A-Z]:\\[^\n\r"]+|\/(?:Users|home|workspace)\/[^\n\r"]+/);
  return match ? match[0].trim() : '';
}

function extractKeywords(text) {
  const counts = new Map();
  const stop = new Set(['about', 'after', 'again', 'also', 'because', 'before', 'build', 'could', 'from', 'have', 'into', 'just', 'like', 'need', 'only', 'that', 'this', 'with', 'what', 'when', 'where', 'will', 'would', 'your']);
  for (const word of text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || []) {
    if (stop.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([word]) => word);
}

function extractTodos(text) {
  return extractLines(text, /\b(todo|next|follow[- ]?up|fix|implement|add|need to)\b/i);
}

function extractDecisions(text) {
  return extractLines(text, /\b(decided|decision|choose|chosen|settled|adopt|use .* instead)\b/i);
}

function extractLines(text, pattern) {
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && pattern.test(line))
    .slice(0, 20);
}

function importRecords(kb, projectId, records) {
  ensureProject(kb, projectId);
  const created = [];
  const skipped = [];

  for (const record of records) {
    const id = `evidence-${slugify(record.source)}-${record.hash.slice(0, 12)}`;
    try {
      created.push(kb.addEntry(projectId, baseEntry(projectId, {
        id,
        name: record.title,
        description: describeRecord(record),
        category: 'history-evidence',
        status: 'draft',
        practicalValue: 'medium',
        confidence: confidence(0.35),
        tags: ['history-import', `source:${record.source}`, `kind:${record.kind}`, `project:${slugify(record.projectHint)}`],
        _extensions: {
          historyImportType: 'evidence',
          promotionState: 'staged',
          normalizedRecord: record,
        },
      })));
    } catch (err) {
      if (err && /already exists|Duplicate/i.test(err.message)) skipped.push({ id, reason: 'duplicate' });
      else throw err;
    }
  }

  return { created, skipped };
}

function describeRecord(record) {
  const parts = [
    `${record.kind} from ${record.source}.`,
    record.projectHint && `Project hint: ${record.projectHint}.`,
    record.messageCount ? `Messages/events: ${record.messageCount}.` : '',
    record.todos.length ? `Possible TODOs: ${record.todos.length}.` : '',
    record.decisions.length ? `Possible decisions: ${record.decisions.length}.` : '',
  ];
  return parts.filter(Boolean).join(' ');
}

function loadRecordsFromSource(source, inputPath) {
  if (source === 'claude-ai') return parseClaudeAiExport(inputPath);
  if (source === 'codex' || source === 'claude-code') return parseJsonlSessions(inputPath, source);
  if (source === 'repo') return inspectGitRepo(inputPath);
  throw new Error(`Unsupported history source "${source}"`);
}

function analyzeProject(kb, projectId = DEFAULT_PROJECT) {
  ensureProject(kb, projectId);
  const evidence = kb.listEntries(projectId, { category: 'history-evidence' });
  const groups = new Map();

  for (const entry of evidence) {
    const record = entry._extensions && entry._extensions.normalizedRecord;
    if (!record) continue;
    const key = slugify(record.projectHint || record.repoPath || 'uncategorized');
    if (!groups.has(key)) {
      groups.set(key, {
        projectKey: key,
        projectName: record.projectHint || key,
        evidenceIds: [],
        sources: new Set(),
        kinds: new Set(),
        keywords: new Map(),
        todos: [],
        decisions: [],
      });
    }
    const group = groups.get(key);
    group.evidenceIds.push(entry.id);
    group.sources.add(record.source);
    group.kinds.add(record.kind);
    for (const keyword of record.keywords || []) group.keywords.set(keyword, (group.keywords.get(keyword) || 0) + 1);
    group.todos.push(...(record.todos || []));
    group.decisions.push(...(record.decisions || []));
  }

  const summaries = [];
  for (const group of groups.values()) {
    const summary = {
      projectKey: group.projectKey,
      projectName: group.projectName,
      evidenceCount: group.evidenceIds.length,
      sources: Array.from(group.sources).sort(),
      kinds: Array.from(group.kinds).sort(),
      topKeywords: Array.from(group.keywords.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([keyword]) => keyword),
      likelyTodos: unique(group.todos).slice(0, 12),
      likelyDecisions: unique(group.decisions).slice(0, 12),
      evidenceIds: group.evidenceIds,
    };
    summaries.push(summary);
    upsertAnalysis(kb, projectId, summary);
  }

  return summaries;
}

function unique(values) {
  return Array.from(new Set(values.map((value) => String(value).trim()).filter(Boolean)));
}

function upsertAnalysis(kb, projectId, summary) {
  const id = `analysis-${summary.projectKey}`;
  const entry = baseEntry(projectId, {
    id,
    name: `Project reconstruction: ${summary.projectName}`,
    description: [
      `Draft reconstruction from ${summary.evidenceCount} imported evidence record(s).`,
      summary.sources.length ? `Sources: ${summary.sources.join(', ')}.` : '',
      summary.topKeywords.length ? `Likely themes: ${summary.topKeywords.slice(0, 8).join(', ')}.` : '',
    ].filter(Boolean).join(' '),
    category: 'project-reconstruction',
    status: 'draft',
    practicalValue: 'high',
    confidence: confidence(0.5),
    tags: ['history-import', 'project-reconstruction', `project:${summary.projectKey}`],
    fusion: { fusedFrom: summary.evidenceIds, fusedAt: now(), fusionDepth: 1 },
    _extensions: {
      historyImportType: 'analysis',
      promotionState: 'review',
      summary,
    },
  });

  try {
    return kb.addEntry(projectId, entry);
  } catch (err) {
    if (!err || !/already exists|Duplicate/i.test(err.message)) throw err;
    return kb.updateEntry(projectId, id, {
      description: entry.description,
      fusion: entry.fusion,
      confidence: entry.confidence,
      _extensions: entry._extensions,
    });
  }
}

function promoteAnalysis(kb, projectId, entryId) {
  const entry = kb.getEntry(projectId, entryId);
  const ext = entry._extensions || {};
  if (ext.historyImportType !== 'analysis') {
    throw new Error(`Entry "${entryId}" is not a project reconstruction analysis.`);
  }
  return kb.updateEntry(projectId, entryId, {
    status: 'active',
    confidence: confidence(0.7, 'unverified'),
    _extensions: {
      ...ext,
      promotionState: 'promoted',
      promotedAt: now(),
    },
  });
}

function promoteAllAnalyses(kb, projectId) {
  return kb.listEntries(projectId, { category: 'project-reconstruction' })
    .filter((entry) => entry.status === 'draft')
    .map((entry) => promoteAnalysis(kb, projectId, entry.id));
}

module.exports = {
  DEFAULT_PROJECT,
  scanSources,
  findGitRepos,
  loadRecordsFromSource,
  parseClaudeAiExport,
  parseJsonlSessions,
  inspectGitRepo,
  importRecords,
  analyzeProject,
  promoteAnalysis,
  promoteAllAnalyses,
  normalizeRecord,
  ensureProject,
};
