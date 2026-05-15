'use strict';

const TEMPORAL_SCHEMA = 'recall_temporal_memory/v1';

const VALID_TIME_SOURCES = {
  EXPLICIT: 'explicit',
  INFERRED_FROM_ADDED_AT: 'inferred_from_added_at',
  INFERRED_FROM_EVIDENCE: 'inferred_from_evidence',
  UNKNOWN: 'unknown',
};

const TEMPORAL_DECISIONS = {
  CURRENT: 'current_valid',
  AS_OF: 'as_of_valid',
  EXPIRED: 'expired_for_time',
  NOT_YET_VALID: 'not_yet_valid_for_time',
  UNKNOWN: 'unknown_validity',
};

const SUPERSESSION_EVENT_SCHEMA = 'recall_temporal_supersession_event/v1';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nowIso(context = {}) {
  return context.now || context.timestamp || new Date().toISOString();
}

function isValidDate(value) {
  if (!value) return false;
  const time = Date.parse(value);
  return Number.isFinite(time);
}

function toIso(value) {
  if (!isValidDate(value)) return '';
  return new Date(value).toISOString();
}

function ext(entry = {}) {
  return entry._extensions || {};
}

function temporalExt(entry = {}) {
  return entry.temporal || ext(entry).temporal || {};
}

function pick(entry, temporal, keys) {
  for (const key of keys) {
    if (entry[key] != null && entry[key] !== '') return entry[key];
    if (temporal[key] != null && temporal[key] !== '') return temporal[key];
  }
  return '';
}

function normalizeTemporalMetadata(entry = {}, context = {}) {
  const temporal = temporalExt(entry);
  const addedAt = entry.addedAt || entry.createdAt || entry.added_at || '';
  const validFromRaw = pick(entry, temporal, ['valid_from', 'validFrom']);
  const validToRaw = pick(entry, temporal, ['valid_to', 'validTo']);
  const validFrom = toIso(validFromRaw || addedAt);
  const validTo = toIso(validToRaw);
  const inferred = !validFromRaw && Boolean(validFrom);
  const validTimeSource = pick(entry, temporal, ['valid_time_source', 'validTimeSource'])
    || (inferred ? VALID_TIME_SOURCES.INFERRED_FROM_ADDED_AT : VALID_TIME_SOURCES.EXPLICIT);
  const confidenceRaw = pick(entry, temporal, ['valid_time_confidence', 'validTimeConfidence']);
  const validTimeConfidence = confidenceRaw === ''
    ? (inferred ? 0.35 : 0.8)
    : Number(confidenceRaw);
  const evidenceRefs = asArray(
    entry.evidenceRefs
    || entry.evidence_refs
    || temporal.evidenceRefs
    || temporal.evidence_refs,
  );
  const supersedes = asArray(entry.supersedes || temporal.supersedes);
  const supersededBy = asArray(entry.supersededBy || entry.superseded_by || temporal.supersededBy || temporal.superseded_by);
  const errors = [];

  if (!validFrom) errors.push('valid_from_unknown');
  if (validTo && validFrom && Date.parse(validTo) <= Date.parse(validFrom)) {
    errors.push('valid_to_must_be_after_valid_from');
  }
  if (!Number.isFinite(validTimeConfidence) || validTimeConfidence < 0 || validTimeConfidence > 1) {
    errors.push('valid_time_confidence_out_of_range');
  }
  if (validTimeSource !== VALID_TIME_SOURCES.EXPLICIT && evidenceRefs.length === 0 && !inferred) {
    errors.push('inferred_valid_time_requires_evidence');
  }

  return {
    schemaVersion: TEMPORAL_SCHEMA,
    entryId: entry.id || entry.entry_id || entry.entryId || '',
    projectId: entry.projectId || entry.project_id || '',
    valid_from: validFrom,
    valid_to: validTo || null,
    valid_time_source: validTimeSource,
    valid_time_confidence: Number.isFinite(validTimeConfidence) ? validTimeConfidence : null,
    valid_time_inferred: inferred || validTimeSource !== VALID_TIME_SOURCES.EXPLICIT,
    transaction_time: {
      added_at: toIso(addedAt) || null,
      updated_at: toIso(entry.updatedAt || entry.updated_at) || null,
      observed_at: toIso(context.observedAt || nowIso(context)),
    },
    supersedes,
    superseded_by: supersededBy,
    evidence_refs: evidenceRefs,
    errors,
  };
}

function temporalDecision(entry = {}, queryContext = {}) {
  const metadata = normalizeTemporalMetadata(entry, queryContext);
  const asOf = toIso(queryContext.asOf || queryContext.validAt || queryContext.now || nowIso(queryContext));
  const reasons = [];

  if (metadata.errors.includes('valid_from_unknown')) {
    return {
      decision: TEMPORAL_DECISIONS.UNKNOWN,
      reasons: ['valid_from_unknown'],
      asOf,
      temporal: metadata,
      abstain: true,
    };
  }

  if (Date.parse(metadata.valid_from) > Date.parse(asOf)) {
    reasons.push('valid_from_after_query_time');
    return {
      decision: TEMPORAL_DECISIONS.NOT_YET_VALID,
      reasons,
      asOf,
      temporal: metadata,
      abstain: false,
    };
  }

  if (metadata.valid_to && Date.parse(metadata.valid_to) <= Date.parse(asOf)) {
    reasons.push('valid_to_before_or_at_query_time');
    return {
      decision: TEMPORAL_DECISIONS.EXPIRED,
      reasons,
      asOf,
      temporal: metadata,
      abstain: false,
    };
  }

  if (metadata.valid_time_inferred && metadata.valid_time_confidence < 0.5 && queryContext.requireCertainValidTime) {
    return {
      decision: TEMPORAL_DECISIONS.UNKNOWN,
      reasons: ['valid_time_inferred_below_required_confidence'],
      asOf,
      temporal: metadata,
      abstain: true,
    };
  }

  return {
    decision: queryContext.asOf || queryContext.validAt ? TEMPORAL_DECISIONS.AS_OF : TEMPORAL_DECISIONS.CURRENT,
    reasons: ['valid_for_query_time'],
    asOf,
    temporal: metadata,
    abstain: false,
  };
}

function filterEntriesAsOf(entries, queryContext = {}) {
  const sourceEntries = asArray(entries);
  const decisions = sourceEntries.map((entry) => temporalDecision(entry, queryContext));
  return {
    entries: sourceEntries
      .map((entry, index) => ({ entry, decision: decisions[index] }))
      .filter(({ decision }) => decision.decision === TEMPORAL_DECISIONS.AS_OF || decision.decision === TEMPORAL_DECISIONS.CURRENT)
      .map(({ entry, decision }) => ({
        ...entry,
        temporal: decision.temporal,
      })),
    abstentions: decisions.filter((decision) => decision.abstain),
    excluded: decisions.filter((decision) => !decision.abstain
      && decision.decision !== TEMPORAL_DECISIONS.AS_OF
      && decision.decision !== TEMPORAL_DECISIONS.CURRENT),
    decisions,
  };
}

function ids(value) {
  return asArray(value).map((item) => String(item)).filter(Boolean);
}

function entryId(entry = {}) {
  return entry.id || entry.entry_id || entry.entryId || '';
}

function supersedesIds(entry = {}) {
  const temporal = temporalExt(entry);
  return ids(entry.supersedes || temporal.supersedes);
}

function supersededByIds(entry = {}) {
  const temporal = temporalExt(entry);
  return ids(entry.supersededBy || entry.superseded_by || temporal.supersededBy || temporal.superseded_by);
}

function buildTimeline(entries, targetEntryId, context = {}) {
  const all = asArray(entries);
  const byId = new Map(all.map((entry) => [entryId(entry), entry]).filter(([id]) => id));
  const target = String(targetEntryId || '');
  const visited = new Set();
  const queue = [target];

  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    const current = byId.get(id);
    if (!current) continue;
    for (const next of [...supersedesIds(current), ...supersededByIds(current)]) {
      if (!visited.has(next)) queue.push(next);
    }
    for (const candidate of all) {
      const candidateId = entryId(candidate);
      if (!candidateId || visited.has(candidateId)) continue;
      if (supersedesIds(candidate).includes(id) || supersededByIds(candidate).includes(id)) {
        queue.push(candidateId);
      }
    }
  }

  const versions = all
    .filter((entry) => visited.has(entryId(entry)))
    .map((entry) => ({
      entry,
      temporal: normalizeTemporalMetadata(entry, context),
      supersedes: supersedesIds(entry),
      superseded_by: supersededByIds(entry),
    }))
    .sort((a, b) => {
      const aTime = Date.parse(a.temporal.valid_from || '') || 0;
      const bTime = Date.parse(b.temporal.valid_from || '') || 0;
      if (aTime !== bTime) return aTime - bTime;
      return entryId(a.entry).localeCompare(entryId(b.entry));
    });

  return {
    targetEntryId: target,
    foundTarget: byId.has(target),
    versionCount: versions.length,
    versions,
    warnings: byId.has(target) ? [] : ['target_entry_not_found'],
  };
}

function buildSupersessionEvent(previousEntry = {}, nextEntry = {}, context = {}) {
  const decidedAt = nowIso(context);
  const previousTemporal = normalizeTemporalMetadata(previousEntry, context);
  const nextTemporal = normalizeTemporalMetadata({
    ...nextEntry,
    valid_from: nextEntry.valid_from || nextEntry.validFrom || decidedAt,
  }, context);
  const evidenceRefs = asArray(context.evidenceRefs || nextEntry.evidenceRefs || nextEntry.evidence_refs);
  const errors = [];

  if (!previousTemporal.entryId) errors.push('previous_entry_id_required');
  if (!nextTemporal.entryId) errors.push('next_entry_id_required');
  if (evidenceRefs.length === 0) errors.push('supersession_requires_evidence');

  return {
    schemaVersion: SUPERSESSION_EVENT_SCHEMA,
    eventType: 'temporal_supersession',
    previousEntryId: previousTemporal.entryId,
    nextEntryId: nextTemporal.entryId,
    valid_to: nextTemporal.valid_from,
    next_valid_from: nextTemporal.valid_from,
    actor: context.actor || 'recall.temporal-memory',
    decidedAt,
    reason: context.reason || nextEntry.reason || '',
    evidenceRefs,
    policy: {
      closesPreviousValidityWindow: true,
      createsNewVersion: true,
      overwritesPreviousEntry: false,
    },
    errors,
  };
}

function traceBlastRadius(entryId, references = [], context = {}) {
  const target = String(entryId || '');
  const asOf = context.asOf || context.validAt || '';
  const hits = asArray(references).filter((ref) => {
    const source = ref.sourceId || ref.source_id || ref.from || '';
    const targetId = ref.targetId || ref.target_id || ref.to || '';
    if (source !== target && targetId !== target) return false;
    if (!asOf) return true;
    const decision = temporalDecision({
      id: ref.id || `${source}->${targetId}`,
      valid_from: ref.valid_from || ref.validFrom || ref.addedAt || ref.createdAt,
      valid_to: ref.valid_to || ref.validTo,
      evidenceRefs: ref.evidenceRefs || ref.evidence_refs || ['reference://implicit'],
    }, { asOf });
    return decision.decision === TEMPORAL_DECISIONS.AS_OF || decision.decision === TEMPORAL_DECISIONS.CURRENT;
  });

  return {
    entryId: target,
    asOf: asOf || null,
    impactedCount: hits.length,
    impacted: hits.map((ref) => ({
      referenceId: ref.id || '',
      sourceId: ref.sourceId || ref.source_id || ref.from || '',
      targetId: ref.targetId || ref.target_id || ref.to || '',
      relation: ref.relation || ref.type || 'references',
      valid_from: ref.valid_from || ref.validFrom || null,
      valid_to: ref.valid_to || ref.validTo || null,
    })),
  };
}

module.exports = {
  TEMPORAL_SCHEMA,
  SUPERSESSION_EVENT_SCHEMA,
  TEMPORAL_DECISIONS,
  VALID_TIME_SOURCES,
  normalizeTemporalMetadata,
  temporalDecision,
  filterEntriesAsOf,
  buildSupersessionEvent,
  traceBlastRadius,
  buildTimeline,
};
