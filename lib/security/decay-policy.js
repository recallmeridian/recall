'use strict';

// Decay policy — elevation-dependent decay constants per namespace
// + auto-archive at confidence floor.
//
// Closes two §5 geomorphic primitives from the 2026-05-12 brainstorm
// in one module since they share state:
//   • Elevation-dependent decay constants — staleness multiplier
//     varies by namespace tier. Basin entries decay in ~72h; denylist
//     entries in minutes; ridge entries in months.
//   • Auto-archive at confidence floor — once an entry's effective
//     confidence drops below a threshold, it leaves the searchable
//     space. Audit ledger keeps the immutable record.
//
// Design contract: this module is pure. Input is the decay-policy
// config + an entry's metadata; output is {effectiveConfidence,
// effectiveStalenessHours, status}. The CLI command wires it to the
// live KB store.
//
// Status values:
//   'fresh'     — within first decay constant; full retrieval weight
//   'aging'     — past first constant but above floor; reduced weight
//   'stale'     — well past constant; reduced weight, surfaced for
//                 human review
//   'archive'   — below floor; auto-archive (not surfaced in
//                 retrieval; ledger keeps the immutable record)
//
// Tier system (default; operator can override):
//   basin.raw            — untrusted ingress, decay-half-life: 24h
//   basin.classified     — classified untrusted, decay-half-life: 72h
//   channel.transitional — promoted candidate awaiting ridge, 7d
//   ridge.validated      — trusted, slow decay, 90d
//   ridge.canonical      — canonical doctrine, 365d
//   denylist             — known-malicious, fast decay (force review), 1h

const DEFAULT_TIERS = {
  'basin.raw':            { halfLifeHours: 24,    floor: 0.10, label: 'untrusted ingress' },
  'basin.classified':     { halfLifeHours: 72,    floor: 0.15, label: 'classified untrusted' },
  'channel.transitional': { halfLifeHours: 7 * 24, floor: 0.20, label: 'promotion candidate' },
  'ridge.validated':      { halfLifeHours: 90 * 24, floor: 0.05, label: 'trusted ridge' },
  'ridge.canonical':      { halfLifeHours: 365 * 24, floor: 0.02, label: 'canonical doctrine' },
  'denylist':             { halfLifeHours: 1,     floor: 0.50, label: 'known malicious' },
};

const DEFAULT_TIER_FOR_CATEGORY = {
  // Map common KB categories to a default tier. Operator can override.
  'decisions':   'ridge.validated',
  'lessons':     'ridge.validated',
  'features':    'ridge.validated',
  'milestones':  'ridge.canonical',
  'todos':       'channel.transitional',
  'plans':       'channel.transitional',
  'handoffs':    'basin.classified',
  'canaries':    'ridge.canonical',
  'imports':     'basin.raw',
};

const DEFAULT_AGING_THRESHOLD = 0.5;
const DEFAULT_STALE_THRESHOLD = 0.2;

function effectiveDecay(ageHours, halfLifeHours) {
  if (!Number.isFinite(ageHours) || ageHours < 0) return 1;
  if (!Number.isFinite(halfLifeHours) || halfLifeHours <= 0) return 1;
  // Exponential half-life decay: confidence factor = 0.5^(age/half-life)
  return Math.pow(0.5, ageHours / halfLifeHours);
}

function tierFor(entry, opts = {}) {
  const tiers = opts.tiers || DEFAULT_TIERS;
  const tierMap = opts.tierMap || DEFAULT_TIER_FOR_CATEGORY;
  // Explicit override on the entry wins.
  if (entry.decayTier && tiers[entry.decayTier]) return entry.decayTier;
  // Then category mapping.
  if (entry.category && tierMap[entry.category]) return tierMap[entry.category];
  // Untrusted-by-default for unknown categories.
  return opts.defaultTier || 'basin.classified';
}

// ageHours can be passed in directly OR computed from createdAt + nowMs.
function evaluateEntry(entry, opts = {}) {
  const tiers = opts.tiers || DEFAULT_TIERS;
  const tierName = tierFor(entry, opts);
  const tier = tiers[tierName];
  if (!tier) throw new Error(`unknown decay tier: ${tierName}`);
  const nowMs = opts.nowMs || Date.now();
  let ageHours;
  if (typeof opts.ageHours === 'number') {
    ageHours = opts.ageHours;
  } else if (entry.createdAt) {
    const t = Date.parse(entry.createdAt);
    ageHours = Number.isFinite(t) ? Math.max(0, (nowMs - t) / (1000 * 60 * 60)) : 0;
  } else {
    ageHours = 0;
  }
  const decayFactor = effectiveDecay(ageHours, tier.halfLifeHours);
  const baseConfidence = typeof entry.confidence === 'number' ? entry.confidence : 1;
  const effectiveConfidence = baseConfidence * decayFactor;
  const aging = opts.agingThreshold || DEFAULT_AGING_THRESHOLD;
  const stale = opts.staleThreshold || DEFAULT_STALE_THRESHOLD;
  let status;
  if (effectiveConfidence < tier.floor) status = 'archive';
  else if (effectiveConfidence < stale) status = 'stale';
  else if (effectiveConfidence < aging) status = 'aging';
  else status = 'fresh';
  return {
    entryId: entry.id,
    project: entry.project || null,
    category: entry.category || null,
    tier: tierName,
    tierLabel: tier.label,
    halfLifeHours: tier.halfLifeHours,
    floor: tier.floor,
    ageHours,
    baseConfidence,
    decayFactor: Number(decayFactor.toFixed(6)),
    effectiveConfidence: Number(effectiveConfidence.toFixed(6)),
    status,
  };
}

function evaluateCorpus(entries, opts = {}) {
  const evaluations = entries.map((e) => evaluateEntry(e, opts));
  const counts = { fresh: 0, aging: 0, stale: 0, archive: 0 };
  for (const e of evaluations) counts[e.status]++;
  const archiveCandidates = evaluations.filter((e) => e.status === 'archive');
  return {
    counts,
    total: evaluations.length,
    archiveCandidates,
    evaluations,
  };
}

function listTiers(opts = {}) {
  return opts.tiers || DEFAULT_TIERS;
}

module.exports = {
  evaluateEntry,
  evaluateCorpus,
  effectiveDecay,
  tierFor,
  listTiers,
  DEFAULT_TIERS,
  DEFAULT_TIER_FOR_CATEGORY,
};
