'use strict';

// Stub for parallel-agent-added import. Their full implementation
// hasn't landed yet; this stub returns an empty catalog so the
// require chain doesn't break the CLI. Replace with their actual
// module when their commit lands.

function buildPolymarketBotCorePortCatalog() {
  return [];
}

module.exports = {
  buildPolymarketBotCorePortCatalog,
};
