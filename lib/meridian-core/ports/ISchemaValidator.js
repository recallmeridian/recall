'use strict';

/**
 * ISchemaValidator — port for MIF v3.2 schema validation.
 * Cockburn 2005 hexagonal: core defines what it needs; adapters deliver it.
 *
 * @abstract
 */
class ISchemaValidator {
  /**
   * Validate a MIF entry object.
   * @param {object} entry
   * @returns {{ valid: boolean, errors: object[]|null }}
   */
  validate(entry) { throw new Error('not implemented: ISchemaValidator#validate'); }

  /**
   * Merge additional AJV property definitions into the base schema.
   * Called by IDomainAdapter.extendSchema() results at startup.
   * @param {{ properties: object, required?: string[] }} patch
   * @returns {void}
   */
  extendSchema(patch) { throw new Error('not implemented: ISchemaValidator#extendSchema'); }
}

module.exports = { ISchemaValidator };
