'use strict';

/**
 * IEntryRepository — port for MIF entry persistence.
 * Cockburn 2005 hexagonal: core defines what it needs; adapters deliver it.
 *
 * @abstract
 */
class IEntryRepository {
  /** @param {string} id @returns {Promise<object|null>} */
  async getById(id) { throw new Error('not implemented: IEntryRepository#getById'); }

  /** @param {{ limit?: number, offset?: number, namespace?: string, visibility?: string }} [opts]
   *  @returns {Promise<object[]>} */
  async list(opts) { throw new Error('not implemented: IEntryRepository#list'); }

  /** @param {object} entry @returns {Promise<object>} created entry */
  async create(entry) { throw new Error('not implemented: IEntryRepository#create'); }

  /** @param {string} id @param {object} patch @returns {Promise<object>} updated entry */
  async update(id, patch) { throw new Error('not implemented: IEntryRepository#update'); }

  /** @param {string} id @returns {Promise<void>} */
  async delete(id) { throw new Error('not implemented: IEntryRepository#delete'); }
}

module.exports = { IEntryRepository };
