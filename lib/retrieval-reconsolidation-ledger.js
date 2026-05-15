'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalSha256 } = require('./canonical-json');

const LEDGER_SCHEMA = 'retrieval_reconsolidation_ledger_record/v1';
const RECONSOLIDATION_SCHEMA = 'retrieval_reconsolidation_candidate/v1';

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function readRetrievalReconsolidationLedger(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw.split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function normalizeReconsolidationEvent(event = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('Reconsolidation event must be an object.');
  }
  if (event.schemaVersion !== RECONSOLIDATION_SCHEMA) {
    throw new Error(`Reconsolidation event schema must be ${RECONSOLIDATION_SCHEMA}.`);
  }
  if (event.eventType !== 'retrieval_reconsolidation_candidate') {
    throw new Error('Reconsolidation event type must be retrieval_reconsolidation_candidate.');
  }
  if (!event.eventId) {
    throw new Error('Reconsolidation event requires eventId.');
  }
  if (!event.candidate || !event.candidate.id) {
    throw new Error('Reconsolidation event requires candidate.id.');
  }
  if (event.policy && event.policy.effect !== 'report_only') {
    throw new Error('Reconsolidation ledger accepts report-only events only.');
  }
  if (event.policy && event.policy.mayMutateMemory !== false) {
    throw new Error('Reconsolidation ledger requires mayMutateMemory=false.');
  }
  return {
    ...event,
    policy: {
      effect: 'report_only',
      mayMutateMemory: false,
      mayChangeRanking: false,
      requiresPromotionBeforeMutation: true,
      ...(event.policy || {}),
    },
  };
}

function recordHash(recordWithoutHash) {
  return canonicalSha256(recordWithoutHash);
}

function appendRetrievalReconsolidationRecord(filePath, event, context = {}) {
  ensureParent(filePath);
  const existing = readRetrievalReconsolidationLedger(filePath);
  const normalizedEvent = normalizeReconsolidationEvent(event);
  const previousHash = existing.length ? existing[existing.length - 1].recordHash : null;
  const recordWithoutHash = {
    schemaVersion: LEDGER_SCHEMA,
    sequence: existing.length + 1,
    previousHash,
    recordedAt: context.now || new Date().toISOString(),
    actor: context.actor || 'recall.retrieval',
    projectId: context.projectId || normalizedEvent.projectId || (normalizedEvent.candidate && normalizedEvent.candidate.projectId) || '',
    eventId: normalizedEvent.eventId,
    eventHash: canonicalSha256(normalizedEvent),
    event: normalizedEvent,
  };
  const record = {
    ...recordWithoutHash,
    recordHash: recordHash(recordWithoutHash),
  };
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

function verifyRetrievalReconsolidationLedger(filePath) {
  const records = readRetrievalReconsolidationLedger(filePath);
  const errors = [];
  let previousHash = null;
  records.forEach((record, index) => {
    const expectedSequence = index + 1;
    if (!record || record.schemaVersion !== LEDGER_SCHEMA) {
      errors.push(`schema_mismatch:${expectedSequence}`);
      return;
    }
    if (record.sequence !== expectedSequence) errors.push(`sequence_mismatch:${expectedSequence}`);
    if ((record.previousHash || null) !== previousHash) errors.push(`previous_hash_mismatch:${expectedSequence}`);
    const { recordHash: actualHash, ...withoutHash } = record;
    const expectedHash = recordHash(withoutHash);
    if (actualHash !== expectedHash) errors.push(`record_hash_mismatch:${expectedSequence}`);
    if (record.eventHash !== canonicalSha256(record.event || {})) errors.push(`event_hash_mismatch:${expectedSequence}`);
    try {
      normalizeReconsolidationEvent(record.event || {});
    } catch (err) {
      errors.push(`event_invalid:${expectedSequence}:${err.message}`);
    }
    previousHash = actualHash || null;
  });
  return {
    ok: errors.length === 0,
    count: records.length,
    lastHash: records.length ? records[records.length - 1].recordHash : null,
    errors,
  };
}

module.exports = {
  LEDGER_SCHEMA,
  appendRetrievalReconsolidationRecord,
  normalizeReconsolidationEvent,
  readRetrievalReconsolidationLedger,
  verifyRetrievalReconsolidationLedger,
};
