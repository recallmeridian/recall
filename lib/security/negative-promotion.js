'use strict';

// Reconsolidation as microbial action — negative-promotion events.
//
// §5 of the 2026-05-12 brainstorm: "Reconsolidation as microbial
// action — each retrieval-without-promotion logs a negative-promotion
// event that further reduces weight."
//
// Mechanism: when a KB entry is retrieved into a reasoning context
// but is NOT promoted (e.g. the consuming agent's output didn't cite
// it, OR the citation didn't contribute to a successful outcome),
// that's a signal the entry is fading. Each negative-promotion event
// applies a small confidence penalty. Many such events => entry
// drifts toward auto-archive without human curation.
//
// This is the inverse of the standard promotion path: instead of
// rewarding the few entries that get cited, we penalize the many
// that get retrieved-but-ignored. Together they create the
// "microbial" pressure the geomorphic frame calls for.
//
// API:
//   recordNegativePromotion({entryId, source, reason, ...})
//     → appends to the negative-promotion ledger
//   summarizePenalty(entryId, opts)
//     → {totalEvents, cumulativePenalty, lastEvent}
//   applyToConfidence(baseConfidence, entryId, opts)
//     → decayed confidence given accumulated penalty
//
// Penalty model: each event applies a multiplicative factor (default
// 0.95). N events compound: confidence' = confidence * 0.95^N. The
// floor (default 0.10) prevents single-purpose entries from being
// driven to zero by a runaway cascade.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PENALTY_FACTOR = 0.95;
const DEFAULT_FLOOR = 0.10;
const DEFAULT_DECAY_HALF_LIFE_HOURS = 14 * 24; // events older than 2 weeks count half

function ledgerPath(opts = {}) {
  return opts.ledgerPath || path.join(opts.dataDir || '', 'security', 'negative-promotion-ledger.jsonl');
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
    eventId: entry.eventId,
    entryId: entry.entryId,
    source: entry.source,
    reason: entry.reason,
    contextHash: entry.contextHash,
    occurredAt: entry.occurredAt,
  })).digest('hex');
}

function recordNegativePromotion({ entryId, source, reason, contextHash = null }, opts = {}) {
  if (!entryId) throw new Error('entryId required');
  if (!reason) throw new Error('reason required (e.g. retrieved-but-not-cited, retrieved-and-contradicted)');
  const filePath = ledgerPath(opts);
  ensureFile(filePath);
  const existing = readLedger(filePath);
  const previous = existing[existing.length - 1] || null;
  const occurredAt = opts.occurredAt || new Date().toISOString();
  const eventId = 'negprom-' + crypto.createHash('sha256').update(entryId + '|' + occurredAt + '|' + reason).digest('hex').slice(0, 16);
  const entry = {
    sequence: existing.length + 1,
    previousHash: previous ? previous.entryHash : null,
    eventId,
    entryId,
    source: source || 'unknown',
    reason,
    contextHash,
    occurredAt,
  };
  entry.entryHash = entryHash(entry);
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

function _allEvents(opts) {
  return readLedger(ledgerPath(opts));
}

function summarizePenalty(entryId, opts = {}) {
  const events = _allEvents(opts).filter((e) => e.entryId === entryId);
  const factor = opts.penaltyFactor || DEFAULT_PENALTY_FACTOR;
  const halfLife = opts.eventDecayHalfLifeHours || DEFAULT_DECAY_HALF_LIFE_HOURS;
  const nowMs = opts.nowMs || Date.now();
  // Each event's weight decays by 0.5^(ageHours/halfLife) so old
  // events still count but less.
  let cumulativePenalty = 1;
  for (const e of events) {
    const t = Date.parse(e.occurredAt) || nowMs;
    const ageHours = Math.max(0, (nowMs - t) / (1000 * 60 * 60));
    const eventWeight = Math.pow(0.5, ageHours / halfLife);
    // Apply a fractional penalty per event = (1 - factor) * weight
    cumulativePenalty *= (1 - (1 - factor) * eventWeight);
  }
  return {
    entryId,
    totalEvents: events.length,
    cumulativePenalty: Number(cumulativePenalty.toFixed(6)),
    lastEvent: events[events.length - 1] || null,
  };
}

function applyToConfidence(baseConfidence, entryId, opts = {}) {
  const floor = opts.floor || DEFAULT_FLOOR;
  const summary = summarizePenalty(entryId, opts);
  const proposed = baseConfidence * summary.cumulativePenalty;
  return Math.max(floor, proposed);
}

function listEvents(opts = {}) {
  const events = _allEvents(opts);
  if (opts.entryId) return events.filter((e) => e.entryId === opts.entryId);
  return events;
}

function verifyLedger(opts = {}) {
  const filePath = ledgerPath(opts);
  if (!fs.existsSync(filePath)) return { ok: true, entries: 0, message: 'no_ledger_yet' };
  const events = _allEvents(opts);
  let prev = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.sequence !== i + 1) return { ok: false, failedAt: i + 1, reason: 'sequence_gap' };
    if (e.previousHash !== (prev ? prev.entryHash : null)) return { ok: false, failedAt: i + 1, reason: 'previous_hash_mismatch' };
    if (entryHash(e) !== e.entryHash) return { ok: false, failedAt: i + 1, reason: 'entry_hash_mismatch' };
    prev = e;
  }
  return { ok: true, entries: events.length, headHash: prev ? prev.entryHash : null };
}

module.exports = {
  recordNegativePromotion,
  summarizePenalty,
  applyToConfidence,
  listEvents,
  verifyLedger,
  DEFAULT_PENALTY_FACTOR,
  DEFAULT_FLOOR,
};
