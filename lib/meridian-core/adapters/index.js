'use strict';

const { KBStoreEntryRepository } = require('./KBStoreEntryRepository');
const { HybridSearchEngine, TIER_DEFAULT_LIMITS, MAX_LIMIT, CANDIDATE_LIMIT } = require('./HybridSearchEngine');
const { MifSchemaValidator } = require('./MifSchemaValidator');
const { RedactionServiceAdapter } = require('./RedactionServiceAdapter');
// Ed25519SigningService is only used in community mode and requires
// @noble/curves as a peer dep. Local-mode users (the npm-installable
// default) don't need it. We import it gracefully so this barrel works
// when the peer dep isn't installed; community-mode consumers will get
// a clear error if they ask for `signing` from a registry that wasn't
// configured for it.
let Ed25519SigningService = null;
try {
  Ed25519SigningService = require('./Ed25519SigningService').Ed25519SigningService;
} catch (err) {
  // Expected when @noble/curves is not installed (local-mode default).
  // Ed25519SigningService remains null; NullSigningService is the fallback.
}
const { NullSigningService } = require('./NullSigningService');
const { NullDomainAdapter } = require('./NullDomainAdapter');
const { OpenAICompatibleLLM } = require('./OpenAICompatibleLLM');
const { GraphEngineRelationRepository } = require('./GraphEngineRelationRepository');

module.exports = {
  KBStoreEntryRepository,
  HybridSearchEngine,
  TIER_DEFAULT_LIMITS,
  MAX_LIMIT,
  CANDIDATE_LIMIT,
  MifSchemaValidator,
  RedactionServiceAdapter,
  Ed25519SigningService,
  NullSigningService,
  NullDomainAdapter,
  OpenAICompatibleLLM,
  GraphEngineRelationRepository,
};
