'use strict';
// Ed25519SigningService — ISigningService adapter using @noble/curves/ed25519.
// Ed25519 chosen per Bernstein et al. 2012 (high performance, constant-time,
// no parameter choices) and existing Meridian signing infrastructure.
//
// API mirrors verify-signature.js (packages/server/src/lib/verify-signature.js):
// keys are hex-encoded 32-byte values; signatures are hex-encoded 64-byte values.
// base64url encoding on output per ISigningService contract.
//
// Strangler Fig (Fowler 2004): v2-entries.js delegates here in Task 4.
const { ISigningService } = require('../ports/ISigningService');
const { ed25519 } = require('@noble/curves/ed25519');
const { sha256 } = require('@noble/hashes/sha2');
const { bytesToHex, hexToBytes } = require('@noble/hashes/utils');

// Canonical JSON serialisation to ensure deterministic signing of objects.
// Sorts keys at every depth — same approach as packages/server/src/lib/canonical-json.js.
function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
}

function payloadToBytes(payload) {
  if (typeof payload === 'string') return new TextEncoder().encode(payload);
  if (payload instanceof Uint8Array) return payload;
  if (Buffer.isBuffer(payload)) return new Uint8Array(payload);
  // Object: canonical JSON → bytes
  return new TextEncoder().encode(canonicalStringify(payload));
}

function toBase64url(hex) {
  const bytes = hexToBytes(hex);
  return Buffer.from(bytes).toString('base64url');
}

function fromBase64url(b64url) {
  return Buffer.from(b64url, 'base64url');
}

/** SHA-256 fingerprint of the 32-byte public key, hex-encoded. */
function fingerprint(publicKeyHex) {
  return bytesToHex(sha256(hexToBytes(publicKeyHex)));
}

class Ed25519SigningService extends ISigningService {
  /**
   * @param {{ privateKeyHex?: string, publicKeyHex?: string }} [opts]
   * If no keys provided, generates an ephemeral key pair at construction.
   */
  constructor(opts = {}) {
    super();
    if (opts.privateKeyHex) {
      this.privateKeyHex = opts.privateKeyHex;
      this.publicKeyHex = opts.publicKeyHex || bytesToHex(ed25519.getPublicKey(hexToBytes(opts.privateKeyHex)));
    } else {
      // Generate ephemeral key pair
      const privBytes = ed25519.utils.randomPrivateKey();
      this.privateKeyHex = bytesToHex(privBytes);
      this.publicKeyHex = bytesToHex(ed25519.getPublicKey(privBytes));
    }
    this.fingerprint = fingerprint(this.publicKeyHex);
  }

  /**
   * Sign a payload.
   * @param {Buffer|Uint8Array|string|object} payload
   * @returns {Promise<string>} base64url-encoded Ed25519 signature (hex internally)
   */
  async sign(payload) {
    const msg = payloadToBytes(payload);
    const sigBytes = ed25519.sign(msg, hexToBytes(this.privateKeyHex));
    return toBase64url(bytesToHex(sigBytes));
  }

  /**
   * Verify a signature.
   * @param {Buffer|Uint8Array|string|object} payload
   * @param {string} signature base64url-encoded signature
   * @returns {Promise<boolean>}
   */
  async verify(payload, signature) {
    try {
      const msg = payloadToBytes(payload);
      const sigHex = bytesToHex(new Uint8Array(fromBase64url(signature)));
      return ed25519.verify(hexToBytes(sigHex), msg, hexToBytes(this.publicKeyHex));
    } catch {
      return false;
    }
  }
}

module.exports = { Ed25519SigningService };
