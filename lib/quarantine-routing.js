'use strict';

const crypto = require('crypto');

const MAX_SCAN_BYTES = 64 * 1024;
const CANDIDATE_REASON = 'no_hostile_heuristic_match';

const LITERAL_HEURISTICS = [
  {
    key: 'ignore_previous_instructions',
    pattern: 'ignore previous instructions',
  },
  {
    key: 'ignore_all_previous_instructions',
    pattern: 'ignore all previous instructions',
  },
  {
    key: 'reveal_system_prompt',
    pattern: 'reveal your system prompt',
  },
  {
    key: 'exfiltrate',
    pattern: 'exfiltrate',
  },
  {
    key: 'publish_this_secret',
    pattern: 'publish this secret',
  },
];

const ROLE_DIRECTIVE_RE = /^\s*(system|developer|assistant|tool)\s*:\s*[^\r\n]*\b(ignore|reveal|exfiltrate|publish|bypass|override)\b/im;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function getRecordText(record) {
  if (!record || typeof record !== 'object') return '';
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  if (typeof record.body === 'string') return record.body;
  return '';
}

function clipForScan(text) {
  return String(text || '').slice(0, MAX_SCAN_BYTES);
}

function contentHashFor(record, text) {
  const existing = record && (record.hash || record.content_hash || record.contentHash);
  if (typeof existing === 'string') {
    const normalized = existing.startsWith('sha256:') ? existing.slice('sha256:'.length) : existing;
    if (SHA256_HEX_RE.test(normalized)) return `sha256:${normalized.toLowerCase()}`;
  }
  return `sha256:${sha256(text)}`;
}

function findHostileHeuristics(text) {
  const clipped = clipForScan(text);
  const scanned = clipped.toLowerCase();
  const hits = [];

  for (const heuristic of LITERAL_HEURISTICS) {
    if (scanned.includes(heuristic.pattern)) hits.push(heuristic.key);
  }

  if (ROLE_DIRECTIVE_RE.test(clipped)) {
    hits.push('line_start_role_directive');
  }

  return Array.from(new Set(hits));
}

function auditEvent(type, timestamp, reasons, contentHash) {
  return {
    type,
    timestamp,
    classifier_reason: reasons,
    content_hash: contentHash,
  };
}

function classifyImportedContentForRouting(record, context = {}) {
  // runtimeMode/sourceType are accepted now so later integration can pass them
  // without changing this dry-run API; they are not load-bearing in this card.
  const text = getRecordText(record);
  const timestamp = context.now || context.timestamp || new Date().toISOString();
  const contentHash = contentHashFor(record, text);
  const hostileReasons = findHostileHeuristics(text);

  if (hostileReasons.length > 0) {
    return {
      decision: 'quarantine',
      partition: 'quarantine_basin',
      source_trust_level: 'untrusted',
      classification_reason: hostileReasons,
      allowed_retrieval_modes: ['explicit_quarantine'],
      allowed_tool_scopes: [],
      auditEvent: auditEvent('quarantine_classification', timestamp, hostileReasons, contentHash),
    };
  }

  return {
    decision: 'candidate',
    partition: 'candidate_basin',
    source_trust_level: 'external_low',
    classification_reason: [CANDIDATE_REASON],
    allowed_retrieval_modes: ['explicit_candidate'],
    allowed_tool_scopes: [],
    auditEvent: auditEvent('candidate_classification', timestamp, [CANDIDATE_REASON], contentHash),
  };
}

module.exports = {
  CANDIDATE_REASON,
  MAX_SCAN_BYTES,
  classifyImportedContentForRouting,
  findHostileHeuristics,
};
