'use strict';

const fs = require('fs');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readJsonOrJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (!text) return [];
  if (text.startsWith('[')) return JSON.parse(text);
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function flattenEvents(input) {
  return asArray(input).flatMap((item) => {
    if (Array.isArray(item)) return flattenEvents(item);
    if (item && Array.isArray(item.events)) return item.events;
    if (item && item.schemaVersion === 'retrieval_reconsolidation_ledger_record/v1' && item.event) return [item.event];
    return item ? [item] : [];
  });
}

function projectOf(event = {}) {
  return event.projectId || (event.candidate && event.candidate.projectId) || 'unknown';
}

function sourceProjectOf(event = {}) {
  return (event.candidate && event.candidate.sourceProjectId)
    || event.sourceProjectId
    || event.source_project_id
    || projectOf(event);
}

function isBridgeCandidate(event = {}) {
  return projectOf(event) !== sourceProjectOf(event);
}

function isAllowed(event = {}) {
  return event.retrievalDecision === 'allow' && event.observation && event.observation.retrieved === true;
}

function bridgeKey(fromProject, toProject) {
  return `${fromProject}->${toProject}`;
}

function emptyBridge(fromProject, toProject) {
  return {
    fromProject,
    toProject,
    retrievals: 0,
    allowedRetrievals: 0,
    deniedRetrievals: 0,
    candidateReviewSignals: 0,
    trustedSignals: 0,
    lowTrustSignals: 0,
    candidateIds: [],
    eventIds: [],
    proposedWeight: 0,
    status: 'observed',
    recommendation: 'observe_only',
  };
}

function updateBridge(bridge, event) {
  bridge.retrievals += 1;
  if (event.retrievalDecision === 'deny') bridge.deniedRetrievals += 1;
  if (isAllowed(event)) bridge.allowedRetrievals += 1;
  if (asArray(event.proposedEffects).includes('candidate_review_signal')) bridge.candidateReviewSignals += 1;
  if (event.candidate && event.candidate.partition === 'trusted_kb' && event.candidate.source_trust_level === 'trusted') {
    bridge.trustedSignals += 1;
  }
  if (event.candidate && event.candidate.source_trust_level !== 'trusted') {
    bridge.lowTrustSignals += 1;
  }
  if (event.candidate && event.candidate.id && !bridge.candidateIds.includes(event.candidate.id)) {
    bridge.candidateIds.push(event.candidate.id);
  }
  if (event.eventId && !bridge.eventIds.includes(event.eventId)) {
    bridge.eventIds.push(event.eventId);
  }
  bridge.proposedWeight = Number((
    bridge.allowedRetrievals
    + bridge.trustedSignals * 0.5
    - bridge.lowTrustSignals * 0.75
    - bridge.deniedRetrievals * 0.5
  ).toFixed(3));
  bridge.status = bridge.proposedWeight > 0 ? 'candidate_bridge' : 'observed';
  bridge.recommendation = bridge.proposedWeight >= 2
    ? 'review_for_bridge_promotion'
    : bridge.proposedWeight > 0
      ? 'keep_observing'
      : 'do_not_promote';
}

function buildCrossProjectBridgeMap(input = {}) {
  const events = flattenEvents(input.events || []);
  const bridges = new Map();
  const ignoredEvents = [];
  const malformedEvents = [];

  for (const event of events) {
    if (!event || event.eventType !== 'retrieval_reconsolidation_candidate' || !event.candidate) {
      malformedEvents.push(event && event.eventId || 'unknown');
      continue;
    }
    if (!isBridgeCandidate(event)) {
      ignoredEvents.push(event.eventId || event.candidate.id || 'unknown');
      continue;
    }
    const fromProject = sourceProjectOf(event);
    const toProject = projectOf(event);
    const key = bridgeKey(fromProject, toProject);
    if (!bridges.has(key)) bridges.set(key, emptyBridge(fromProject, toProject));
    updateBridge(bridges.get(key), event);
  }

  const bridgeList = Array.from(bridges.values())
    .sort((left, right) => right.proposedWeight - left.proposedWeight
      || right.allowedRetrievals - left.allowedRetrievals
      || left.fromProject.localeCompare(right.fromProject)
      || left.toProject.localeCompare(right.toProject));
  const promotionCandidates = bridgeList.filter((bridge) => bridge.recommendation === 'review_for_bridge_promotion');
  const errors = [];
  const warnings = [];
  if (malformedEvents.length) warnings.push('malformed_reconsolidation_events_ignored');
  if (promotionCandidates.length) warnings.push('bridge_promotion_review_candidates_present');

  return {
    ok: errors.length === 0,
    status: warnings.length ? 'warning' : 'healthy',
    generatedAt: input.now || new Date().toISOString(),
    schemaVersion: 'cross_project_bridge_map/v1',
    sourceEventCount: events.length,
    ignoredEventCount: ignoredEvents.length,
    bridgeCount: bridgeList.length,
    promotionCandidateCount: promotionCandidates.length,
    bridges: bridgeList,
    ignoredEvents,
    malformedEvents,
    errors,
    warnings,
    policy: {
      effect: 'report_only',
      mayMutateRetrieval: false,
      mayPromoteBridgeWeights: false,
      requiresHumanPromotion: true,
    },
    researchGrounding: [
      'bio-inspired-recall-architecture-2026',
      'behavioral-immune-layer-ai-defense-2026',
      'memorygraft-2025-poisoned-experience-retrieval',
    ],
  };
}

function buildCrossProjectBridgeMapFromFile(opts = {}) {
  return buildCrossProjectBridgeMap({
    now: opts.now,
    events: readJsonOrJsonl(opts.eventsPath),
  });
}

module.exports = {
  buildCrossProjectBridgeMap,
  buildCrossProjectBridgeMapFromFile,
  readJsonOrJsonl,
  flattenEvents,
};
