'use strict';

// Append-only hash-chained ledger for egress DLP scan results.
//
// Mirrors the pattern used by feature-runs / approvals / reconsolidation
// ledgers in this repo. Each entry includes the previous entry's hash,
// making tampering detectable by `verifyLedger`.
//
// We store the scan VERDICT (decision + blockers metadata + content hash),
// never the raw content. Provenance without leakage.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function defaultLedgerPath(dataDir) {
  return path.join(dataDir, 'security', 'egress-scan-ledger.jsonl');
}

function ensureLedgerFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', 'utf8');
}

function readEntries(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) return [];
  return raw.trim().split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch (_) { return null; }
  }).filter(Boolean);
}

function entryHash(entry) {
  const canonical = JSON.stringify({
    sequence: entry.sequence,
    previousHash: entry.previousHash,
    scanId: entry.scanId,
    decision: entry.decision,
    contentHash: entry.contentHash,
    contentBytes: entry.contentBytes,
    kind: entry.kind,
    target: entry.target,
    sourcePath: entry.sourcePath,
    blockerIds: entry.blockerIds,
    warningIds: entry.warningIds,
    detectorVersion: entry.detectorVersion,
    scannedAt: entry.scannedAt,
  });
  return 'sha256:' + crypto.createHash('sha256').update(canonical).digest('hex');
}

function appendScan(scanResult, opts = {}) {
  const filePath = opts.ledgerPath || defaultLedgerPath(opts.dataDir || path.join(require('os').homedir(), '.recall'));
  ensureLedgerFile(filePath);
  const existing = readEntries(filePath);
  const previous = existing[existing.length - 1] || null;
  const entry = {
    sequence: existing.length + 1,
    previousHash: previous ? previous.entryHash : null,
    scanId: scanResult.scanId,
    decision: scanResult.decision,
    contentHash: scanResult.contentHash,
    contentBytes: scanResult.contentBytes,
    kind: scanResult.kind,
    target: scanResult.target,
    sourcePath: scanResult.sourcePath,
    blockerIds: (scanResult.blockers || []).map((b) => b.detectorId),
    warningIds: (scanResult.warnings || []).map((w) => w.detectorId),
    detectorVersion: scanResult.detectorVersion,
    scannedAt: scanResult.scannedAt,
  };
  entry.entryHash = entryHash(entry);
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
  return { ledgerPath: filePath, entry };
}

function listScans(opts = {}) {
  const filePath = opts.ledgerPath || defaultLedgerPath(opts.dataDir || path.join(require('os').homedir(), '.recall'));
  const entries = readEntries(filePath);
  const limit = opts.limit ? Number(opts.limit) : entries.length;
  return entries.slice(-limit);
}

function verifyLedger(opts = {}) {
  const filePath = opts.ledgerPath || defaultLedgerPath(opts.dataDir || path.join(require('os').homedir(), '.recall'));
  if (!fs.existsSync(filePath)) {
    return { ok: true, ledgerPath: filePath, entries: 0, message: 'no_ledger_yet' };
  }
  const entries = readEntries(filePath);
  let prevHash = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.sequence !== i + 1) {
      return { ok: false, ledgerPath: filePath, failedAt: i + 1, reason: 'sequence_gap', expectedSequence: i + 1, gotSequence: e.sequence };
    }
    if (e.previousHash !== prevHash) {
      return { ok: false, ledgerPath: filePath, failedAt: i + 1, reason: 'previous_hash_mismatch', expectedPrev: prevHash, gotPrev: e.previousHash };
    }
    const recomputed = entryHash({
      sequence: e.sequence,
      previousHash: e.previousHash,
      scanId: e.scanId,
      decision: e.decision,
      contentHash: e.contentHash,
      contentBytes: e.contentBytes,
      kind: e.kind,
      target: e.target,
      sourcePath: e.sourcePath,
      blockerIds: e.blockerIds,
      warningIds: e.warningIds,
      detectorVersion: e.detectorVersion,
      scannedAt: e.scannedAt,
    });
    if (recomputed !== e.entryHash) {
      return { ok: false, ledgerPath: filePath, failedAt: i + 1, reason: 'entry_hash_mismatch', expected: recomputed, got: e.entryHash };
    }
    prevHash = e.entryHash;
  }
  return { ok: true, ledgerPath: filePath, entries: entries.length, headHash: prevHash };
}

module.exports = {
  appendScan,
  listScans,
  verifyLedger,
  defaultLedgerPath,
};
