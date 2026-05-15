'use strict';
// KBStoreEntryRepository — IEntryRepository adapter for Recall's local KBStore.
// Strangler Fig pattern (Fowler 2004): existing KBStore stays untouched;
// this adapter is the seam that lets routes speak to the IEntryRepository port.
const { IEntryRepository } = require('../ports/IEntryRepository');
const { KBStore } = require('../lib/kb-store');

class KBStoreEntryRepository extends IEntryRepository {
  /**
   * @param {KBStore} kbStore
   * @param {string} projectId - baked in at construction; all ops scoped to this project
   */
  constructor(kbStore, projectId) {
    super();
    this.kb = kbStore;
    this.projectId = projectId;
  }

  async getById(id) {
    return this.kb.getEntry(this.projectId, id) ?? null;
  }

  async list(opts = {}) {
    return this.kb.listEntries(this.projectId, opts);
  }

  async create(entry) {
    return this.kb.addEntry(this.projectId, entry);
  }

  async update(id, patch) {
    return this.kb.updateEntry(this.projectId, id, patch);
  }

  async delete(id) {
    // KBStore uses status='retired' as soft-delete; wrap to match port contract
    return this.kb.updateEntry(this.projectId, id, { status: 'retired' });
  }
}

module.exports = { KBStoreEntryRepository };
