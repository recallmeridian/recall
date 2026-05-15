'use strict';

/**
 * IDomainAdapter — the build-on extension point.
 * Cockburn 2005 hexagonal: build-ons implement this port to extend Meridian
 * without touching core internals.
 *
 * All methods have safe defaults — build-ons only override what they need.
 * Null Object pattern (Fowler 2002): NullDomainAdapter extends this with no overrides.
 *
 * @abstract
 */
class IDomainAdapter {
  /**
   * Return an AJV schema patch to merge into the base MIF v3.2 schema, or null.
   * @returns {{ properties: object, required?: string[] }|null}
   */
  extendSchema() { return null; }

  /**
   * Return a rerank weight multiplier (float ≥ 0) for entries matching a
   * domain-specific predicate, or null to use the default weight.
   * @param {object} entry MIF entry object
   * @returns {number|null}
   */
  rerankWeight(entry) { return null; }

  /**
   * Mount additional HTTP routes onto the provided Express router.
   * Called once at app startup. No-op by default.
   * @param {import('express').Router} router
   * @returns {void}
   */
  mountRoutes(router) {}
}

module.exports = { IDomainAdapter };
