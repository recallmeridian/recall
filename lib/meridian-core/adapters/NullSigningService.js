'use strict';

/**
 * NullSigningService — ISigningService adapter for local-mode deployments.
 *
 * Local mode (Recall, private researcher KBs, enterprise behind firewall)
 * does not require cryptographic signing. This adapter returns always-valid
 * results so the pipeline never branches on "is signing enabled".
 *
 * Use case: Meridian community mode uses Ed25519SigningService (real keys,
 * real verification). Local mode uses this. Same code paths, different
 * adapter at the composition root.
 *
 * Pattern: Null Object (Woolf 1998 — "The Null Object Pattern") — eliminates
 * conditional checks in consumers by providing a no-op implementation of
 * the interface contract.
 *
 * Behavior:
 *   sign(payload)             → empty-string signature
 *   verify(payload, signature) → true (always)
 *
 * The empty-string sentinel makes "this entry is not signed" explicit at
 * the data layer; consumers don't need to special-case null vs missing.
 */

const { ISigningService } = require('../ports/ISigningService');

class NullSigningService extends ISigningService {
  // eslint-disable-next-line no-unused-vars
  async sign(_payload) {
    return '';
  }

  // eslint-disable-next-line no-unused-vars
  async verify(_payload, _signature) {
    return true;
  }
}

module.exports = { NullSigningService };
