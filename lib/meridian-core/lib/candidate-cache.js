'use strict';

// Plan 1D Task 10 — In-process LRU + TTL cache for pre-rerank top-50.
//
// Pattern: Anthropic prompt cache (short TTL, read-through) + classic LRU
// (Johnson 1975 / Knuth TAoCP 3). 60s TTL is not a knob — dogfood authors
// publish new signed entries every few minutes; longer TTL would surface
// stale candidate sets that hide freshly-added content. Map preserves
// insertion order, so LRU-touch = delete + re-insert; oldest is first key.
// Lazy expiration on read avoids a sweeper timer (no unref/teardown hazard
// in tests). Interface (get, set, key) mirrors Redis so Plan 2A can swap
// stores without touching the route.

const crypto = require('crypto');

class CandidateCache {
  constructor({ ttlMs = 60_000, maxSize = 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    // LRU touch: re-insert to move to tail (most-recent position).
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.store.has(key)) this.store.delete(key);
    else if (this.store.size >= this.maxSize) {
      this.store.delete(this.store.keys().next().value);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  static key(input) {
    return crypto.createHash('sha256').update(canonicalStringify(input)).digest('hex');
  }
}

// Recursively sort object keys at every depth so {q,tier} and {tier,q} hash
// identically. Arrays stay order-significant (order is semantic in arrays).
function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') + '}';
}

module.exports = { CandidateCache };
