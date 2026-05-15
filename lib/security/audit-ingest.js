'use strict';

// OpenClaw Audit Ingest — Slice #3 of Codex's 5-slice build order
// from the 2026-05-12 brainstorm.
//
// Pattern: any agent (OpenClaw eventually, Claude Code, MCP clients
// today) can submit a record of an action it took or attempted.
// Records arrive as UNTRUSTED CANDIDATES by default — they go into
// a separate ledger, never directly into the trusted KB. Promotion
// requires a real ceremony (matching the vector promotion gate
// invariant): explicit approval, evidence, no live-write auto-
// promote.
//
// This is the receiver-side of the contract. The producer (any
// agent) is decoupled — the agent doesn't even need to be a Recall
// component; it just calls the ingest API.
//
// Record shape (defensive — accept any of these fields):
//   {
//     agentId,           // who is reporting (e.g. "openclaw-mac", "claude-code-jesse")
//     actionKind,        // 'post' | 'tool_call' | 'http_request' | 'file_write' | etc.
//     target,            // kind-specific descriptor
//     rationale,         // why the agent did/tried this
//     outcome,           // 'attempted' | 'succeeded' | 'blocked' | 'errored'
//     evidence,          // KB entry ids the agent cited
//     timestamp,         // ISO string; auto-filled if missing
//     contentHash,       // optional sha256 of the action content
//   }
//
// API:
//   submitAuditRecord(record, opts)   → {recordId, entry}
//   listAuditRecords({status?, agentId?, limit?})
//   promoteAuditRecord(recordId, {humanApproval, evidence, opts})
//     → moves status untrusted → trusted; requires human approval ref
//   rejectAuditRecord(recordId, {reason, opts})
//   verifyAuditLedger(opts)            → hash-chain integrity check
//
// Every state change is itself appended to the same hash-chained
// ledger — the record's CURRENT state is the latest event for that
// recordId. Auditors can reconstruct the full lifecycle by walking
// the chain.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATUS = Object.freeze({
  UNTRUSTED: 'untrusted',
  TRUSTED: 'trusted',
  REJECTED: 'rejected',
});

const EVENT_KIND = Object.freeze({
  SUBMITTED: 'submitted',
  PROMOTED: 'promoted',
  REJECTED: 'rejected',
});

function ledgerPath(opts = {}) {
  return opts.ledgerPath || path.join(opts.dataDir || '', 'security', 'audit-ingest-ledger.jsonl');
}

function ensureFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', 'utf8');
}

function readLedger(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
}

function entryHash(entry) {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify({
    sequence: entry.sequence,
    previousHash: entry.previousHash,
    eventKind: entry.eventKind,
    recordId: entry.recordId,
    agentId: entry.agentId,
    actionKind: entry.actionKind,
    target: entry.target,
    rationale: entry.rationale,
    outcome: entry.outcome,
    evidence: entry.evidence,
    timestamp: entry.timestamp,
    contentHash: entry.contentHash,
    statusAfter: entry.statusAfter,
    approvalRef: entry.approvalRef,
    rejectReason: entry.rejectReason,
  })).digest('hex');
}

function _appendEvent(filePath, event) {
  ensureFile(filePath);
  const existing = readLedger(filePath);
  const previous = existing[existing.length - 1] || null;
  const enriched = {
    sequence: existing.length + 1,
    previousHash: previous ? previous.entryHash : null,
    ...event,
  };
  enriched.entryHash = entryHash(enriched);
  fs.appendFileSync(filePath, JSON.stringify(enriched) + '\n', 'utf8');
  return enriched;
}

function submitAuditRecord(record, opts = {}) {
  if (!record || typeof record !== 'object') throw new Error('record must be an object');
  if (!record.agentId) throw new Error('record.agentId is required');
  if (!record.actionKind) throw new Error('record.actionKind is required');

  const filePath = ledgerPath(opts);
  const timestamp = record.timestamp || new Date().toISOString();
  const recordId = 'audit-' + crypto.createHash('sha256')
    .update(record.agentId + '|' + record.actionKind + '|' + timestamp + '|' + JSON.stringify(record.target || ''))
    .digest('hex').slice(0, 16);

  const event = {
    eventKind: EVENT_KIND.SUBMITTED,
    recordId,
    agentId: record.agentId,
    actionKind: record.actionKind,
    target: record.target || null,
    rationale: record.rationale || null,
    outcome: record.outcome || 'attempted',
    evidence: record.evidence || [],
    timestamp,
    contentHash: record.contentHash || null,
    statusAfter: STATUS.UNTRUSTED,
    approvalRef: null,
    rejectReason: null,
  };

  const entry = _appendEvent(filePath, event);
  return { recordId, entry };
}

function _allEvents(opts) {
  return readLedger(ledgerPath(opts));
}

function _eventsByRecord(opts) {
  const events = _allEvents(opts);
  const byRecord = new Map();
  for (const e of events) {
    if (!byRecord.has(e.recordId)) byRecord.set(e.recordId, []);
    byRecord.get(e.recordId).push(e);
  }
  return byRecord;
}

function _currentRecord(recordId, opts) {
  const events = _allEvents(opts).filter((e) => e.recordId === recordId);
  if (events.length === 0) return null;
  const latest = events[events.length - 1];
  const first = events[0];
  return {
    recordId,
    agentId: first.agentId,
    actionKind: first.actionKind,
    target: first.target,
    rationale: first.rationale,
    outcome: first.outcome,
    evidence: first.evidence,
    timestamp: first.timestamp,
    contentHash: first.contentHash,
    status: latest.statusAfter,
    approvalRef: latest.approvalRef,
    rejectReason: latest.rejectReason,
    eventCount: events.length,
    lastUpdated: latest.timestamp,
  };
}

function listAuditRecords(opts = {}) {
  const byRecord = _eventsByRecord(opts);
  const records = [];
  for (const recordId of byRecord.keys()) {
    const rec = _currentRecord(recordId, opts);
    if (!rec) continue;
    if (opts.status && rec.status !== opts.status) continue;
    if (opts.agentId && rec.agentId !== opts.agentId) continue;
    records.push(rec);
  }
  records.sort((a, b) => (b.lastUpdated || '').localeCompare(a.lastUpdated || ''));
  if (opts.limit) return records.slice(0, Number(opts.limit));
  return records;
}

function getAuditRecord(recordId, opts = {}) {
  return _currentRecord(recordId, opts);
}

function promoteAuditRecord(recordId, { humanApproval, evidence }, opts = {}) {
  if (!humanApproval) throw new Error('humanApproval is required to promote untrusted record to trusted');
  const current = _currentRecord(recordId, opts);
  if (!current) throw new Error('record not found: ' + recordId);
  if (current.status !== STATUS.UNTRUSTED) {
    throw new Error('record is not in untrusted state (current=' + current.status + ')');
  }
  // Kernel invariant: live-write actions can never be auto-promoted.
  // Promotion still requires explicit human approval — we just refuse
  // to consider a missing approval as implicit.
  const filePath = ledgerPath(opts);
  const event = {
    eventKind: EVENT_KIND.PROMOTED,
    recordId,
    agentId: current.agentId,
    actionKind: current.actionKind,
    target: current.target,
    rationale: current.rationale,
    outcome: current.outcome,
    evidence: evidence || current.evidence || [],
    timestamp: new Date().toISOString(),
    contentHash: current.contentHash,
    statusAfter: STATUS.TRUSTED,
    approvalRef: humanApproval,
    rejectReason: null,
  };
  return _appendEvent(filePath, event);
}

function rejectAuditRecord(recordId, { reason }, opts = {}) {
  if (!reason) throw new Error('reason is required to reject');
  const current = _currentRecord(recordId, opts);
  if (!current) throw new Error('record not found: ' + recordId);
  if (current.status === STATUS.REJECTED) {
    throw new Error('record already rejected');
  }
  const filePath = ledgerPath(opts);
  const event = {
    eventKind: EVENT_KIND.REJECTED,
    recordId,
    agentId: current.agentId,
    actionKind: current.actionKind,
    target: current.target,
    rationale: current.rationale,
    outcome: current.outcome,
    evidence: current.evidence || [],
    timestamp: new Date().toISOString(),
    contentHash: current.contentHash,
    statusAfter: STATUS.REJECTED,
    approvalRef: null,
    rejectReason: reason,
  };
  return _appendEvent(filePath, event);
}

function verifyAuditLedger(opts = {}) {
  const filePath = ledgerPath(opts);
  if (!fs.existsSync(filePath)) return { ok: true, entries: 0, message: 'no_ledger_yet' };
  const entries = _allEvents(opts);
  let prev = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.sequence !== i + 1) return { ok: false, failedAt: i + 1, reason: 'sequence_gap' };
    if (e.previousHash !== (prev ? prev.entryHash : null)) return { ok: false, failedAt: i + 1, reason: 'previous_hash_mismatch' };
    if (entryHash(e) !== e.entryHash) return { ok: false, failedAt: i + 1, reason: 'entry_hash_mismatch' };
    prev = e;
  }
  return { ok: true, entries: entries.length, headHash: prev ? prev.entryHash : null };
}

module.exports = {
  STATUS,
  EVENT_KIND,
  submitAuditRecord,
  listAuditRecords,
  getAuditRecord,
  promoteAuditRecord,
  rejectAuditRecord,
  verifyAuditLedger,
};
