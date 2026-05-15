'use strict';
// NullDomainAdapter — default no-op IDomainAdapter.
// Null Object pattern (Fowler 2002): avoids null checks at call sites.
// Meridian core ships no domain; build-ons register their own IDomainAdapter.
const { IDomainAdapter } = require('../ports/IDomainAdapter');

class NullDomainAdapter extends IDomainAdapter {
  // All three methods inherited from IDomainAdapter:
  //   extendSchema() → null
  //   rerankWeight(entry) → null
  //   mountRoutes(router) → (no-op)
}

module.exports = { NullDomainAdapter };
