'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalSha256 } = require('./canonical-json');
const { normalizeSecurityEvent } = require('./security-event');

const REDACTED = '[redacted]';
const DENIED_KEYS = new Set([
  'payload',
  'rawPayload',
  'rawText',
  'text',
  'body',
  'content',
  'entry',
  'envelope',
  'description',
  'message',
  'name',
  'note',
  'privateKey',
  'secret',
  'apiKey',
  'token',
]);

function redact(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (DENIED_KEYS.has(key)) {
      output[key] = REDACTED;
    } else {
      output[key] = redact(item);
    }
  }
  return output;
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function readAuditEvents(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw.split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function normalizeAuditEvent(event, context = {}) {
  return redact(normalizeSecurityEvent(event, context));
}

function appendAuditEvent(filePath, event, context = {}) {
  ensureParent(filePath);
  const existing = readAuditEvents(filePath);
  const normalized = normalizeAuditEvent(event, context);
  const previousHash = existing.length ? existing[existing.length - 1].eventHash : null;
  const recordWithoutHash = {
    sequence: existing.length + 1,
    previousHash,
    ...normalized,
  };
  const eventHash = canonicalSha256(recordWithoutHash);
  const record = {
    ...recordWithoutHash,
    eventHash,
  };
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

function eventsForResource(filePath, resourceId) {
  return readAuditEvents(filePath).filter((event) => event.resource && event.resource.id === resourceId);
}

module.exports = {
  appendAuditEvent,
  eventsForResource,
  normalizeAuditEvent,
  readAuditEvents,
};
