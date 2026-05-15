'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PATTERN = /^claude-audit-result-.*\.md$/i;
const OPEN_STATUSES = new Set(['open', 'todo', 'pending', 'unresolved', 'failing']);
const CLOSED_STATUSES = new Set(['closed', 'fixed', 'resolved', 'done']);
const TRACKER_STATUSES = new Set(['open', 'closed', 'stale_missing']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info', 'unknown']);

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
  return slug || 'finding';
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeSeverity(value, fallbackId = '') {
  const text = String(value || '').trim().toLowerCase();
  if (SEVERITIES.has(text)) return text;
  const id = String(fallbackId || '').trim().toUpperCase();
  if (/^C\d+/.test(id)) return 'critical';
  if (/^H\d+/.test(id)) return 'high';
  if (/^M\d+/.test(id)) return 'medium';
  if (/^L\d+/.test(id)) return 'low';
  return 'unknown';
}

function normalizeStatus(value) {
  const text = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (TRACKER_STATUSES.has(text)) return text;
  if (OPEN_STATUSES.has(text)) return 'open';
  if (CLOSED_STATUSES.has(text)) return 'closed';
  if (text === 'false' || text === 'unchecked') return 'open';
  if (text === 'true' || text === 'checked') return 'closed';
  return 'open';
}

function extractLine(section, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = section.match(new RegExp(`^\\s*(?:[-*]\\s*)?\\*{0,2}${escaped}\\*{0,2}\\s*[:=-]\\s*(.+)$`, 'im'));
    if (match) return match[1].trim();
  }
  return '';
}

function inferDateFromPath(filePath, stat) {
  const base = path.basename(filePath);
  const match = base.match(/(20\d{2})[-_]?(\d{2})[-_]?(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`;
  return stat ? stat.mtime.toISOString() : now();
}

function parseFindingHeading(line) {
  const match = String(line || '').match(/^#{1,6}\s*(?:\[(critical|high|medium|low|info)\]\s*)?(?:(C|H|M|L|F|P)(\d+))?\s*[:.)\]-]?\s*(.+?)\s*$/i);
  if (!match) return null;
  const title = (match[4] || '').trim();
  if (!match[1] && !match[2]) return null;
  const findingId = match[2] ? `${match[2].toUpperCase()}${match[3]}` : '';
  return {
    findingId,
    severity: normalizeSeverity(match[1], findingId),
    title: title || findingId || 'Audit finding',
  };
}

function splitFindingSections(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const sections = [];
  let current = null;

  lines.forEach((line) => {
    const heading = parseFindingHeading(line);
    if (heading) {
      if (current) sections.push(current);
      current = {
        heading,
        lines: [line],
      };
      return;
    }
    if (current) current.lines.push(line);
  });

  if (current) sections.push(current);
  return sections;
}

function parseAuditFile(filePath, opts = {}) {
  const absolutePath = path.resolve(filePath);
  const raw = fs.readFileSync(absolutePath, 'utf8').replace(/^\uFEFF/, '');
  const stat = fs.statSync(absolutePath);
  const openedAtFallback = inferDateFromPath(absolutePath, stat);
  const auditId = slugify(path.basename(absolutePath, path.extname(absolutePath)));
  const sections = splitFindingSections(raw);
  const seenFindingIds = new Map();

  return sections.map((section, index) => {
    const body = section.lines.join('\n');
    const explicitId = extractLine(body, ['Finding ID', 'ID', 'Issue ID']);
    const headingId = section.heading.findingId || '';
    const baseFindingId = slugify(explicitId || headingId || `finding-${index + 1}`);
    const seenCount = seenFindingIds.get(baseFindingId) || 0;
    seenFindingIds.set(baseFindingId, seenCount + 1);
    const findingId = seenCount === 0 ? baseFindingId : `${baseFindingId}-${seenCount + 1}`;
    const severity = normalizeSeverity(
      extractLine(body, ['Severity', 'Priority']) || section.heading.severity,
      headingId
    );
    const status = normalizeStatus(extractLine(body, ['Status', 'State']) || (/\[[xX]\]/.test(section.lines[0]) ? 'closed' : 'open'));
    const title = extractLine(body, ['Title']) || section.heading.title || findingId;
    const closedInCommit = extractLine(body, ['Closed in commit', 'Closed-In-Commit', 'Fixed in commit', 'Commit']);
    const openedAt = extractLine(body, ['Opened at', 'Opened', 'Created at', 'Created']) || openedAtFallback;
    const fileRefs = Array.from(body.matchAll(/(?:^|\s)([\w./\\:-]+\.(?:js|ts|json|md|py|yml|yaml|html|css))(?:[:#](\d+))?/g))
      .map((match) => match[2] ? `${match[1]}:${match[2]}` : match[1])
      .slice(0, 20);

    return {
      id: `${auditId}-${findingId}`,
      auditId,
      findingId,
      title,
      severity,
      status,
      openedAt,
      closedAt: status === 'closed' ? now() : '',
      closedInCommit,
      sourcePath: absolutePath,
      sourceMtime: stat.mtime.toISOString(),
      contentHash: sha256(body),
      fileRefs,
      excerpt: body.slice(0, 1200),
      updatedAt: now(),
    };
  });
}

function listAuditFiles(rootPath, opts = {}) {
  const root = path.resolve(rootPath || process.cwd());
  const ignored = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage']);
  const results = [];
  const stack = [root];
  const maxFiles = opts.maxFiles || 5000;

  while (stack.length > 0 && results.length < maxFiles) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) stack.push(absolute);
      } else if (entry.isFile() && DEFAULT_PATTERN.test(entry.name)) {
        results.push(absolute);
      }
    }
  }

  return results.sort();
}

function ensureTable(kb) {
  kb.db.exec(`
    CREATE TABLE IF NOT EXISTS recall_audit_debt (
      id TEXT PRIMARY KEY,
      audit_id TEXT NOT NULL,
      finding_id TEXT NOT NULL,
      title TEXT NOT NULL,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      closed_in_commit TEXT,
      source_path TEXT NOT NULL,
      source_mtime TEXT,
      content_hash TEXT NOT NULL,
      file_refs TEXT,
      excerpt TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recall_audit_debt_status ON recall_audit_debt(status);
    CREATE INDEX IF NOT EXISTS idx_recall_audit_debt_severity ON recall_audit_debt(severity);
    CREATE INDEX IF NOT EXISTS idx_recall_audit_debt_opened ON recall_audit_debt(opened_at);
  `);
}

function rowFromFinding(finding) {
  return {
    id: finding.id,
    audit_id: finding.auditId,
    finding_id: finding.findingId,
    title: finding.title,
    severity: finding.severity,
    status: finding.status,
    opened_at: finding.openedAt,
    closed_at: finding.closedAt || null,
    closed_in_commit: finding.closedInCommit || null,
    source_path: finding.sourcePath,
    source_mtime: finding.sourceMtime,
    content_hash: finding.contentHash,
    file_refs: JSON.stringify(finding.fileRefs || []),
    excerpt: finding.excerpt || '',
    updated_at: finding.updatedAt || now(),
  };
}

function findingFromRow(row) {
  return {
    id: row.id,
    auditId: row.audit_id,
    findingId: row.finding_id,
    title: row.title,
    severity: row.severity,
    status: row.status,
    openedAt: row.opened_at,
    closedAt: row.closed_at || '',
    closedInCommit: row.closed_in_commit || '',
    sourcePath: row.source_path,
    sourceMtime: row.source_mtime || '',
    contentHash: row.content_hash,
    fileRefs: row.file_refs ? JSON.parse(row.file_refs) : [],
    excerpt: row.excerpt || '',
    updatedAt: row.updated_at,
  };
}

function upsertFinding(kb, finding) {
  ensureTable(kb);
  const existing = kb.db.prepare('SELECT * FROM recall_audit_debt WHERE id = ?').get(finding.id);
  const merged = existing && existing.status === 'closed'
    ? {
      ...finding,
      status: 'closed',
      closedAt: existing.closed_at || finding.closedAt || '',
      closedInCommit: existing.closed_in_commit || finding.closedInCommit || '',
    }
    : finding;
  kb.db.prepare(`
    INSERT INTO recall_audit_debt (
      id, audit_id, finding_id, title, severity, status, opened_at, closed_at,
      closed_in_commit, source_path, source_mtime, content_hash, file_refs, excerpt, updated_at
    ) VALUES (
      @id, @audit_id, @finding_id, @title, @severity, @status, @opened_at, @closed_at,
      @closed_in_commit, @source_path, @source_mtime, @content_hash, @file_refs, @excerpt, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      audit_id = excluded.audit_id,
      finding_id = excluded.finding_id,
      title = excluded.title,
      severity = excluded.severity,
      status = excluded.status,
      opened_at = excluded.opened_at,
      closed_at = excluded.closed_at,
      closed_in_commit = excluded.closed_in_commit,
      source_path = excluded.source_path,
      source_mtime = excluded.source_mtime,
      content_hash = excluded.content_hash,
      file_refs = excluded.file_refs,
      excerpt = excluded.excerpt,
      updated_at = excluded.updated_at
  `).run(rowFromFinding(merged));
  return merged;
}

function scanAuditDebt(kb, rootPath, opts = {}) {
  ensureTable(kb);
  const files = opts.files || listAuditFiles(rootPath, opts);
  const findings = files.flatMap((file) => parseAuditFile(file, opts));
  const inserted = findings.map((finding) => upsertFinding(kb, finding));
  markMissingFindings(kb, files, findings);
  return {
    rootPath: path.resolve(rootPath || process.cwd()),
    fileCount: files.length,
    findingCount: inserted.length,
    openCount: inserted.filter((finding) => finding.status === 'open').length,
    closedCount: inserted.filter((finding) => finding.status === 'closed').length,
    files,
    findings: inserted,
  };
}

function markMissingFindings(kb, files, findings) {
  const seenIds = new Set(findings.map((finding) => finding.id));
  const rows = kb.db.prepare('SELECT id, source_path FROM recall_audit_debt WHERE status = ?').all('open');
  const scannedPaths = new Set(files.map((file) => path.resolve(file)));
  const missingIds = rows
    .filter((row) => {
      if (!fs.existsSync(row.source_path)) return true;
      if (!scannedPaths.has(path.resolve(row.source_path))) return false;
      return !seenIds.has(row.id);
    })
    .map((row) => row.id);
  const stmt = kb.db.prepare(`
    UPDATE recall_audit_debt
    SET status = 'stale_missing',
        updated_at = @updatedAt
    WHERE id = @id
  `);
  const updatedAt = now();
  for (const id of missingIds) stmt.run({ id, updatedAt });
}

function listDebt(kb, filters = {}) {
  ensureTable(kb);
  const where = [];
  const params = {};
  if (filters.status) {
    where.push('status = @status');
    params.status = normalizeStatus(filters.status);
  }
  if (filters.severity) {
    where.push('severity = @severity');
    params.severity = normalizeSeverity(filters.severity);
  }
  if (filters.auditId) {
    where.push('audit_id = @auditId');
    params.auditId = filters.auditId;
  }
  const requestedLimit = filters.limit ? Number(filters.limit) : 200;
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, requestedLimit) : 200;
  params.limit = limit;
  const sql = `
    SELECT * FROM recall_audit_debt
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY
      CASE severity
        WHEN 'critical' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
        ELSE 4
      END,
      opened_at ASC,
      id ASC
    LIMIT @limit
  `;
  return kb.db.prepare(sql).all(params).map(findingFromRow);
}

function closeDebt(kb, id, opts = {}) {
  ensureTable(kb);
  const existing = kb.db.prepare('SELECT * FROM recall_audit_debt WHERE id = ?').get(id);
  if (!existing) throw new Error(`Audit debt not found: ${id}`);
  const commit = String(opts.commit || '').trim();
  if (!commit) throw new Error('Closing audit debt requires a commit.');
  const closedAt = opts.closedAt || now();
  kb.db.prepare(`
    UPDATE recall_audit_debt
    SET status = 'closed',
        closed_at = @closedAt,
        closed_in_commit = @closedInCommit,
        updated_at = @updatedAt
    WHERE id = @id
  `).run({
    id,
    closedAt,
    closedInCommit: commit,
    updatedAt: now(),
  });
  return findingFromRow(kb.db.prepare('SELECT * FROM recall_audit_debt WHERE id = ?').get(id));
}

module.exports = {
  parseAuditFile,
  listAuditFiles,
  scanAuditDebt,
  listDebt,
  closeDebt,
  ensureTable,
  normalizeSeverity,
  normalizeStatus,
};
