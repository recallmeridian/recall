'use strict';

/**
 * IRedactionService — port for PII redaction.
 * Cockburn 2005 hexagonal: core defines what it needs; adapters deliver it.
 *
 * @abstract
 */
class IRedactionService {
  /**
   * Redact PII from text.
   * @param {string} text
   * @returns {Promise<{ redacted: string, entities: object[] }>}
   */
  async redact(text) { throw new Error('not implemented: IRedactionService#redact'); }
}

module.exports = { IRedactionService };
