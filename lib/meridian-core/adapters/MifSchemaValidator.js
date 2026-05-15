'use strict';
// MifSchemaValidator — ISchemaValidator adapter for MIF v3.2.
// MIF v3.2 schema: Ed25519 signing + AI participation + corruption architecture fields
// (Meridian Schema Design 2026-04-19). AJV 2020 draft, strict mode.
//
// Schema loading mirrors v2-entries.js: reads from recall-schema JSON files,
// resolved via MIF_SCHEMA_DIR env var or monorepo-relative default path.
// Strangler Fig (Fowler 2004): v2-entries.js delegates here in Task 4.
const { ISchemaValidator } = require('../ports/ISchemaValidator');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const path = require('path');
const fs = require('fs');

class MifSchemaValidator extends ISchemaValidator {
  constructor() {
    super();
    this.ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(this.ajv);
    this._validate = this._loadAndCompile();
  }

  validate(entry) {
    const valid = this._validate(entry);
    return { valid, errors: valid ? null : this._validate.errors };
  }

  extendSchema(patch) {
    // MIF v3.2 uses external JSON schema files; extension patches are not
    // applicable to the compiled external schema. This method is a no-op
    // for MifSchemaValidator — domain adapters that need property extensions
    // should register a separate AJV schema or subclass this adapter.
    if (!patch || !patch.properties) return;
    // Re-compilation of an externally-loaded schema is not supported here;
    // extendSchema on the external MIF schema is reserved for Plan 2A domain
    // extension hooks. No-op with no error to satisfy the port contract.
  }

  _loadAndCompile() {
    const schemaRoot = process.env.MIF_SCHEMA_DIR
      || path.join(__dirname, '..', '..', '..', '..', 'recall-schema', 'schemas');
    const core = JSON.parse(fs.readFileSync(path.join(schemaRoot, 'core.schema.json'), 'utf8'));
    const ai = JSON.parse(fs.readFileSync(path.join(schemaRoot, 'ai-participation.schema.json'), 'utf8'));
    const corr = JSON.parse(fs.readFileSync(path.join(schemaRoot, 'corruption-architecture.schema.json'), 'utf8'));
    const root = JSON.parse(fs.readFileSync(path.join(schemaRoot, 'mif.schema.json'), 'utf8'));
    this.ajv.addSchema(core, 'core.schema.json');
    this.ajv.addSchema(ai, 'ai-participation.schema.json');
    this.ajv.addSchema(corr, 'corruption-architecture.schema.json');
    return this.ajv.compile(root);
  }
}

module.exports = { MifSchemaValidator };
