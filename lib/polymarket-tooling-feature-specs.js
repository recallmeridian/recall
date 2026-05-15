'use strict';

// Public stub. The real polymarket tooling feature catalog lives in a
// separate private repository and references infrastructure paths that
// are not appropriate for public distribution.
//
// In public builds the stub returns empty results so the rest of the
// feature catalog loads correctly. Private/internal builds substitute
// this file with the full catalog at install time.
//
// Restored to repo on 2026-05-14 to fix the regression introduced in
// commit 17aa24f (v0.12.0) where lib/core-feature-catalog.js began
// requiring this module but the module itself was never committed.

function buildPolymarketToolingFeatureSpecs() {
  return [];
}

function renderPolymarketToolingFeaturePacket() {
  return {
    feature_count: 0,
    build_order: [],
    features: [],
  };
}

module.exports = {
  buildPolymarketToolingFeatureSpecs,
  renderPolymarketToolingFeaturePacket,
};
