'use strict';

const DECAY_DEFAULTS = {
  'mechanism': 3650,
  'experimental-finding': 180,
  'hypothesis': 365,
  'failed-approach': 1825,
  'drug-target': 365,
  'biomarker': 180,
  'clinical-observation': 90,
  'method': 730
};

const DEFAULT_DECAY = 365;

function getDefaultDecayDays(category) {
  return DECAY_DEFAULTS[category] || DEFAULT_DECAY;
}

function computeStaleness(entry) {
  const confidence = entry.confidence || {};

  if (confidence.exempt === true) {
    return { isStale: false, daysOverdue: 0, urgency: 'ok' };
  }

  const decayDays = confidence.decayDays || getDefaultDecayDays(entry.category);
  const lastVerified = confidence.lastVerified || entry.updatedAt || entry.addedAt || new Date().toISOString();

  const now = Date.now();
  const verifiedAt = new Date(lastVerified).getTime();
  const daysSince = Math.floor((now - verifiedAt) / (1000 * 60 * 60 * 24));

  if (daysSince <= decayDays) {
    return { isStale: false, daysOverdue: 0, urgency: 'ok' };
  }

  const daysOverdue = daysSince - decayDays;
  const urgency = daysSince > decayDays * 2 ? 'critical' : 'warning';

  return { isStale: true, daysOverdue, urgency };
}

module.exports = { computeStaleness, getDefaultDecayDays };
