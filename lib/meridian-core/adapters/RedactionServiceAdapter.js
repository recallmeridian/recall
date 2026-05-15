'use strict';
// RedactionServiceAdapter — IRedactionService adapter for the Presidio redaction sidecar.
// Strangler Fig (Fowler 2004): routes/redaction.js delegates to this in Task 4.
const { IRedactionService } = require('../ports/IRedactionService');

const REDACTION_TIMEOUT_MS = 5000;

class RedactionServiceAdapter extends IRedactionService {
  /**
   * @param {{ url?: string }} [opts]
   */
  constructor(opts = {}) {
    super();
    this.url = opts.url || process.env.PRESIDIO_URL || 'http://localhost:5001';
  }

  /**
   * Redact PII from text via the Presidio sidecar /analyze endpoint.
   * Network/timeout errors throw; callers should catch and map to 503.
   * @param {string} text
   * @returns {Promise<{ spans: object[] }>}
   */
  async redact(text) {
    const endpoint = this.url + '/analyze';
    let upstream;
    try {
      upstream = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language: 'en' }),
        signal: AbortSignal.timeout(REDACTION_TIMEOUT_MS),
      });
    } catch (err) {
      // Network / timeout / DNS — sidecar is unreachable
      const e = new Error('redaction_unavailable');
      e.cause = err;
      e.code = 'REDACTION_UNAVAILABLE';
      throw e;
    }

    // Distinguish 4xx (client-side) from 5xx (sidecar broken)
    if (upstream.status >= 400 && upstream.status < 500) {
      const e = new Error('invalid_redaction_input');
      e.code = 'INVALID_REDACTION_INPUT';
      e.status = upstream.status;
      throw e;
    }
    if (!upstream.ok) {
      const e = new Error('redaction_unavailable');
      e.code = 'REDACTION_UNAVAILABLE';
      e.status = upstream.status;
      throw e;
    }

    let body;
    try {
      body = await upstream.json();
    } catch (err) {
      const e = new Error('invalid_redaction_input');
      e.code = 'INVALID_REDACTION_INPUT';
      e.cause = err;
      throw e;
    }

    // Validate shape before returning — a malformed spans array would crash consumers
    if (!Array.isArray(body.spans)) {
      const e = new Error('invalid_redaction_input');
      e.code = 'INVALID_REDACTION_INPUT';
      throw e;
    }

    return { spans: body.spans };
  }
}

module.exports = { RedactionServiceAdapter };
