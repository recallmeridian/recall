'use strict';

/**
 * ISearchEngine — port for hybrid BM25+dense retrieval.
 * Cockburn 2005 hexagonal: core defines what it needs; adapters deliver it.
 *
 * @abstract
 */
class ISearchEngine {
  /**
   * @param {string} query
   * @param {{ limit?: number, tier?: 'summary'|'default'|'full', facets?: string,
   *           namespace?: string, visibility?: string }} [opts]
   * @returns {Promise<{ results: object[], sufficient: boolean,
   *                     recommend_refetch: string[], meta: object }>}
   */
  async search(query, opts) { throw new Error('not implemented: ISearchEngine#search'); }
}

module.exports = { ISearchEngine };
