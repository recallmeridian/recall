'use strict';

// Live collectors for the Nightly Dream Cycle. Each function reads
// from a real source (KB store / IL ledger / scan ledger / anchor
// ledger) and returns the {count, samples?, ...} shape that
// dream-cycle.js synthesizes proposals from.
//
// Best-effort: any collector that errors returns a {skipped, error}
// shape so the dream run continues.

const fs = require('fs');
const path = require('path');

function readJsonlTail(filePath, limit = 200) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean).slice(-limit);
}

function entriesInWindow(entries, hours, timestampField = 'createdAt') {
  if (!entries.length) return [];
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return entries.filter((e) => {
    const ts = e[timestampField];
    if (!ts) return true; // no ts = include conservatively
    const t = Date.parse(ts);
    return Number.isFinite(t) && t >= cutoff;
  });
}

function buildLiveCollectors({ store, dataDir, project = 'recall-dev' } = {}) {
  return {
    reconsolidationEvents({ windowHours }) {
      const filePath = path.join(dataDir, 'reconsolidation.jsonl');
      const all = readJsonlTail(filePath, 500);
      const recent = entriesInWindow(all, windowHours, 'createdAt');
      return {
        count: recent.length,
        latest: recent[recent.length - 1] ? recent[recent.length - 1].entryHash || recent[recent.length - 1].id : null,
      };
    },

    basinEntries({ windowHours }) {
      // Approximation: count entries created in the last N hours
      // across the project (no formal "basin" tag yet — those are the
      // pending-promotion candidates).
      try {
        const entries = store.listEntries(project) || [];
        const recent = entriesInWindow(entries, windowHours, 'createdAt');
        return {
          count: recent.length,
          samples: recent.slice(0, 5).map((e) => e.id),
        };
      } catch (err) {
        return { count: 0, error: err.message };
      }
    },

    morphologyDelta() {
      // Stub — feature-terrain-snapshot/diff exist but invoking them
      // safely from here is non-trivial. Surfacing a "skipped" so the
      // operator knows it's a follow-up.
      return { skipped: 'terrain-diff invocation pending wire-up' };
    },

    graphAnchorDrift() {
      // Compare current state to most recent graph anchor.
      try {
        const { listAnchors, verifyAgainstAnchor } = require('./graph-anchor');
        const { buildSnapshotInputs } = require('./graph-snapshot');
        const anchors = listAnchors({ dataDir });
        if (anchors.length === 0) return { skipped: 'no_anchor' };
        const latest = anchors[anchors.length - 1];
        const inputs = buildSnapshotInputs(store, { dataDir });
        const result = verifyAgainstAnchor(inputs, latest, { dataDir });
        return {
          rootChanged: !result.ok || result.drift.rootChanged,
          subRootsChanged: result.drift ? result.drift.subRootsChanged : [],
          anchorId: latest.anchorId,
        };
      } catch (err) {
        return { skipped: 'error', error: err.message };
      }
    },

    deniedActions({ windowHours }) {
      const filePath = path.join(dataDir, 'security', 'egress-scan-ledger.jsonl');
      const all = readJsonlTail(filePath, 500);
      const recent = entriesInWindow(all, windowHours, 'scannedAt');
      const denied = recent.filter((e) => e.decision === 'block' || e.decision === 'review');
      return { count: denied.length };
    },

    hardCases({ windowHours }) {
      const filePath = path.join(dataDir, 'intelligence', 'hard-cases.jsonl');
      const all = readJsonlTail(filePath, 500);
      const recent = entriesInWindow(all, windowHours, 'createdAt');
      return { count: recent.length };
    },
  };
}

module.exports = {
  buildLiveCollectors,
};
