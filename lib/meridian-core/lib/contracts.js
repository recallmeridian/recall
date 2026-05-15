'use strict';

// contracts.js — duck-typing port contract assertion helper.
//
// "Test the interface, not the implementation" (Beck 2003, TDD).
// Checks that every method defined on a port base class is present
// (and callable) on a concrete adapter — without using instanceof.
// This lets you validate adapters from external packages that don't
// necessarily inherit from the exact port class in this module.

/**
 * Assert that an adapter implements all methods of a port interface.
 * Throws a descriptive Error if any method is missing or not a function.
 *
 * @param {object} instance - adapter instance to validate
 * @param {Function} PortClass - port base class (e.g. ISearchEngine)
 * @throws {Error} if a required method is absent or not a function
 */
function assertImplementsPort(instance, PortClass) {
  const portProto = PortClass.prototype;
  const missing = [];

  for (const methodName of Object.getOwnPropertyNames(portProto)) {
    if (methodName === 'constructor') continue;
    if (typeof portProto[methodName] !== 'function') continue;

    if (typeof instance[methodName] !== 'function') {
      missing.push(methodName);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `${instance.constructor.name || 'instance'} does not implement ` +
      `${PortClass.name} — missing: ${missing.join(', ')}`
    );
  }
}

module.exports = { assertImplementsPort };
