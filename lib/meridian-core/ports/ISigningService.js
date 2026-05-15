'use strict';

/**
 * ISigningService — port for Ed25519 entry signing.
 * Cockburn 2005 hexagonal: core defines what it needs; adapters deliver it.
 *
 * @abstract
 */
class ISigningService {
  /**
   * Sign a payload.
   * @param {Buffer|string} payload
   * @returns {Promise<string>} base64url signature
   */
  async sign(payload) { throw new Error('not implemented: ISigningService#sign'); }

  /**
   * Verify a signature.
   * @param {Buffer|string} payload
   * @param {string} signature base64url
   * @returns {Promise<boolean>}
   */
  async verify(payload, signature) { throw new Error('not implemented: ISigningService#verify'); }
}

module.exports = { ISigningService };
