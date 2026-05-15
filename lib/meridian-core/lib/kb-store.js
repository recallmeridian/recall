'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const { computeStaleness } = require('./staleness');
const { EventLog } = require('./event-log');
const { SemanticSearch } = require('./semantic-search');
const {
  ValidationError,
  EntryNotFoundError,
  DuplicateEntryError,
  ProjectNotFoundError,
} = require('./errors');

// ---------------------------------------------------------------------------
// MIF v4.0 core schema (breaking change from v3.0 — see BREAKING.md)
// ---------------------------------------------------------------------------
const MIF_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['id', 'name', 'description', 'status', 'category', 'projectId', 'schemaVersion'],
  additionalProperties: false,  // v4.0 disciplines unknown fields → must use _extensions
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*[a-z0-9]$' },
    schemaVersion: { type: 'string', const: '4.0' },
    projectId: { type: 'string' },
    category: { type: 'string' },
    name: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['active', 'retired', 'draft'] },

    addedAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    retiredAt: { type: ['string', 'null'], format: 'date-time' },

    confidence: {
      type: 'object',
      additionalProperties: false,
      properties: {
        value: { type: 'number', minimum: 0, maximum: 1 },
        lastVerified: { type: 'string', format: 'date-time' },
        decayDays: { type: 'number', minimum: 0 },
        exempt: { type: 'boolean' },
        verificationStatus: {
          type: 'string',
          enum: ['verified', 'unverified', 'stale', 'contradicted']
        }
      }
    },

    // NOTE: usage telemetry (lastShownAt, lastUsedAt, responseStrength) is
    // hub-local — stored in a separate entry_usage table (Task 3), NOT in the
    // signed payload. See Q2 design override discussion at the top of Task 2.

    fusion: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fusedFrom:    { type: 'array', items: { type: 'string' } },
        fusedAt:      { type: ['string', 'null'], format: 'date-time' },
        fusionDepth:  { type: 'integer', minimum: 0, maximum: 5 }
      }
    },

    practicalValue: {
      type: 'string',
      enum: ['high', 'medium', 'low', 'unrated']
    },

    source:    { type: 'string' },
    sourceUrl: { type: 'string', format: 'uri' },
    authors:   { type: 'array', items: { type: 'string' } },
    tags:      { type: 'array', items: { type: 'string' } },
    jsonPath:  { type: 'string' },

    // Biotech domain vocabulary — author-asserted claims (like authors/tags),
    // carried over from v3. Optional; empty for non-biotech KBs. Distinct from
    // hub-computed fields which live in separate tables (see entry_usage).
    disease_area: { type: 'string' },
    genes:        { type: 'array', items: { type: 'string' } },
    pathways:     { type: 'array', items: { type: 'string' } },

    // Other domain-specific plugin fields live here.
    // Engine ignores. Plugins read.
    _extensions: { type: 'object', additionalProperties: true },

    // Internal field added by getEntry — not stored in JSON, stripped before validation
    _staleness: {}
  }
};

// Build AJV validator once
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validateMIF = ajv.compile(MIF_SCHEMA);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toKebabCase(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')   // strip non-alphanumeric (except spaces and hyphens)
    .trim()
    .replace(/[\s_]+/g, '-')         // spaces/underscores → hyphens
    .replace(/-+/g, '-')             // collapse multiple hyphens
    .replace(/^-|-$/g, '');          // strip leading/trailing hyphens
}

function now() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// KBStore class
// ---------------------------------------------------------------------------
class KBStore {
  /**
   * @param {string|{dataDir: string}} dataDirOrOpts  Root data directory (string) or options
   *   object with a `dataDir` key. Both forms are accepted for compatibility.
   */
  constructor(dataDirOrOpts) {
    const dataDir = (dataDirOrOpts && typeof dataDirOrOpts === 'object')
      ? dataDirOrOpts.dataDir
      : dataDirOrOpts;
    this.dataDir = dataDir;
    this.kbDir = path.join(dataDir, 'kb');
    this.configPath = path.join(this.kbDir, 'config.json');
    this.dbPath = path.join(this.kbDir, 'meridian.db');

    // Ensure directory structure
    fs.mkdirSync(this.kbDir, { recursive: true });

    // Initialize config
    if (!fs.existsSync(this.configPath)) {
      fs.writeFileSync(this.configPath, JSON.stringify({ projects: [] }, null, 2));
    }

    // Open SQLite and create schema
    this.db = new Database(this.dbPath);
    this._initDb();
    this.events = new EventLog(this.db);
    this.semanticSearch = new SemanticSearch(this.db);
  }

  // -------------------------------------------------------------------------
  // Internal: DB init
  // -------------------------------------------------------------------------
  _initDb() {
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT NOT NULL,
        projectId TEXT NOT NULL,
        name TEXT,
        description TEXT,
        status TEXT,
        category TEXT,
        tags TEXT,
        disease_area TEXT,
        genes TEXT,
        pathways TEXT,
        addedAt TEXT,
        updatedAt TEXT,
        -- v4.0 indexed projections of confidence sub-object + practical_value
        -- + source_trust_id. Mirrored from the JSON blob at write time so
        -- hydrated rows (HybridSearchEngine.hydrate → SELECT *) carry these
        -- flat columns into the reranker. Without this projection, the
        -- reranker's confidence_score / last_verified / decay_exempt / kin
        -- factors all degrade to neutral 1.0 (the JSON blob is opaque to
        -- the SQL query layer).
        confidence_score REAL,
        last_verified TEXT,
        decay_days INTEGER,
        decay_exempt INTEGER,
        practical_value TEXT,
        source_trust_id TEXT,
        PRIMARY KEY (projectId, id)
      );

      CREATE TABLE IF NOT EXISTS relationships (
        fromProject TEXT NOT NULL,
        fromId TEXT NOT NULL,
        toProject TEXT NOT NULL,
        toId TEXT NOT NULL,
        type TEXT,
        PRIMARY KEY (fromProject, fromId, toProject, toId)
      );

      -- Hub-local usage telemetry. Per Q2 design override (Recall KB entry
      -- qualityscore-belongs-hub-local-not-in-signed-payload), fields the
      -- hub computes / applies policy to must NOT live in the signed entry
      -- payload. Different hubs see different interaction histories;
      -- different rerankers compute responseStrength differently. Avoids
      -- the "every reranker tweak forces KB re-sign" trap.
      CREATE TABLE IF NOT EXISTS entry_usage (
        projectId         TEXT NOT NULL,
        id                TEXT NOT NULL,
        lastShownAt       TEXT,
        lastUsedAt        TEXT,
        responseStrength  REAL,
        updatedAt         TEXT NOT NULL,
        PRIMARY KEY (projectId, id)
      );
      CREATE INDEX IF NOT EXISTS idx_entry_usage_used
        ON entry_usage(lastUsedAt);
      CREATE INDEX IF NOT EXISTS idx_entry_usage_shown
        ON entry_usage(lastShownAt);

      -- entries_fts and its triggers are owned by server migration 008.
      -- KBStore consumers running outside the server context (CLI, tests)
      -- must run the migration or set up FTS5 themselves; search() falls
      -- back to LIKE when FTS5 is absent.
    `);

    // 0.2.2 schema realization — idempotent ALTER for DBs created under
    // 0.2.0/0.2.1 which lacked the v4 confidence/practical_value projection
    // columns. Each ALTER is wrapped because PRAGMA table_info returns
    // existing columns; we only add what's missing.
    this._addColumnIfMissing('entries', 'confidence_score', 'REAL');
    this._addColumnIfMissing('entries', 'last_verified',    'TEXT');
    this._addColumnIfMissing('entries', 'decay_days',       'INTEGER');
    this._addColumnIfMissing('entries', 'decay_exempt',     'INTEGER');
    this._addColumnIfMissing('entries', 'practical_value',  'TEXT');
    this._addColumnIfMissing('entries', 'source_trust_id',  'TEXT');
  }

  // 0.2.2 — idempotent ALTER TABLE helper. SQLite has no IF NOT EXISTS
  // for ADD COLUMN; we check via PRAGMA table_info first.
  _addColumnIfMissing(tableName, columnName, columnType) {
    const cols = this.db.prepare(`PRAGMA table_info(${tableName})`).all();
    if (cols.some((c) => c.name === columnName)) return;
    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }

  // -------------------------------------------------------------------------
  // Internal: config helpers
  // -------------------------------------------------------------------------
  _readConfig() {
    return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
  }

  _writeConfig(config) {
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
  }

  _projectDir(projectId) {
    return path.join(this.kbDir, projectId);
  }

  _indexPath(projectId) {
    return path.join(this._projectDir(projectId), '_index.json');
  }

  _entryPath(projectId, entryId) {
    return path.join(this._projectDir(projectId), `${entryId}.json`);
  }

  _readIndex(projectId) {
    const p = this._indexPath(projectId);
    if (!fs.existsSync(p)) return { entries: [] };
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  _writeIndex(projectId, index) {
    fs.writeFileSync(this._indexPath(projectId), JSON.stringify(index, null, 2));
  }

  // -------------------------------------------------------------------------
  // Internal: validation
  // -------------------------------------------------------------------------
  _validate(entry) {
    const valid = validateMIF(entry);
    if (!valid) {
      // Build a human-readable summary that includes field names so callers can
      // match on e.g. /schemaVersion/, /confidence/, /usage/, etc.
      const errSummary = (validateMIF.errors || [])
        .map(e => {
          // instancePath looks like "/confidence" or "/fusion/fusionDepth"
          const field = e.instancePath ? e.instancePath.replace(/^\//, '') : '';
          // additionalProperties errors put the extra property name in params
          const extra = (e.params && e.params.additionalProperty) ? e.params.additionalProperty : '';
          // const failures put the expected value in params.allowedValues / params.allowedValue
          const allowed = (e.params && (e.params.allowedValues || e.params.allowedValue))
            ? JSON.stringify(e.params.allowedValues || e.params.allowedValue)
            : '';
          return [field, extra, e.keyword, allowed].filter(Boolean).join(' ');
        })
        .join('; ');
      throw new ValidationError(
        `Entry validation failed (MIF v4.0): ${errSummary}`,
        validateMIF.errors
      );
    }
  }

  // -------------------------------------------------------------------------
  // Internal: SQLite index helpers
  // -------------------------------------------------------------------------
  _indexEntry(entry) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO entries
        (id, projectId, name, description, status, category, tags,
         disease_area, genes, pathways, addedAt, updatedAt,
         confidence_score, last_verified, decay_days, decay_exempt,
         practical_value, source_trust_id)
      VALUES
        (@id, @projectId, @name, @description, @status, @category, @tags,
         @disease_area, @genes, @pathways, @addedAt, @updatedAt,
         @confidence_score, @last_verified, @decay_days, @decay_exempt,
         @practical_value, @source_trust_id)
    `);
    // Domain-specific fields (disease_area, genes, pathways) live in _extensions in v4.0.
    // We still populate the SQL index columns so legacy queries (e.g. WHERE disease_area = ...)
    // continue to work — the column is the SQL-index projection, not the canonical store.
    const ext = entry._extensions || {};
    const conf = entry.confidence || {};
    stmt.run({
      id: entry.id,
      projectId: entry.projectId,
      name: entry.name || '',
      description: entry.description || '',
      status: entry.status || '',
      category: entry.category || '',
      tags: Array.isArray(entry.tags) ? entry.tags.join(' ') : (entry.tags || ''),
      disease_area: ext.disease_area || entry.disease_area || '',
      genes: Array.isArray(ext.genes || entry.genes) ? (ext.genes || entry.genes).join(' ') : (ext.genes || entry.genes || ''),
      pathways: Array.isArray(ext.pathways || entry.pathways) ? (ext.pathways || entry.pathways).join(' ') : (ext.pathways || entry.pathways || ''),
      addedAt: entry.addedAt || '',
      updatedAt: entry.updatedAt || '',
      // v4 projections — fed to reranker via HybridSearchEngine.hydrate
      confidence_score: typeof conf.value === 'number' ? conf.value : null,
      last_verified:    conf.lastVerified || null,
      decay_days:       typeof conf.decayDays === 'number' ? conf.decayDays : null,
      decay_exempt:     conf.exempt ? 1 : 0,
      practical_value:  entry.practicalValue || null,
      // source_trust_id is hub-policy data; populate from _extensions if a
      // domain plugin has set it. Otherwise null → reranker treats as
      // non-trusted (KIN_BOOST = 1.0).
      source_trust_id:  (ext.source_trust_id) || null,
    });
  }

  _deindexEntry(projectId, entryId) {
    this.db.prepare('DELETE FROM entries WHERE projectId = ? AND id = ?').run(projectId, entryId);
  }

  // -------------------------------------------------------------------------
  // Project management
  // -------------------------------------------------------------------------
  createProject({ id, name, description = '' }) {
    const config = this._readConfig();
    if (config.projects.find(p => p.id === id)) {
      throw new Error(`Project "${id}" already exists`);
    }
    const project = { id, name, description, createdAt: now() };
    config.projects.push(project);
    this._writeConfig(config);

    // Create project directory + empty index
    const dir = this._projectDir(id);
    fs.mkdirSync(dir, { recursive: true });
    this._writeIndex(id, { entries: [] });

    this.events.emit('project_created', id, null, { name, description });

    return project;
  }

  listProjects() {
    const config = this._readConfig();
    return config.projects;
  }

  _assertProject(projectId) {
    const config = this._readConfig();
    if (!config.projects.find(p => p.id === projectId)) {
      throw new ProjectNotFoundError(projectId);
    }
  }

  // -------------------------------------------------------------------------
  // Entry CRUD
  // -------------------------------------------------------------------------
  addEntry(projectId, fields) {
    this._assertProject(projectId);

    const id = fields.id || toKebabCase(fields.name || '');
    if (!id || id.length < 2) {
      throw new ValidationError(`Cannot derive a valid ID from name "${fields.name}"`);
    }

    // Check duplicate
    const filePath = this._entryPath(projectId, id);
    if (fs.existsSync(filePath)) {
      throw new DuplicateEntryError(projectId, id);
    }

    const ts = now();
    const entry = {
      schemaVersion: '4.0',
      ...fields,
      id,
      projectId,
      addedAt: ts,
      updatedAt: ts,
    };

    this._validate(entry);

    // Write JSON file
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2));

    // Update manifest
    const index = this._readIndex(projectId);
    index.entries.push({ id, name: entry.name, category: entry.category });
    this._writeIndex(projectId, index);

    // Index in SQLite
    this._indexEntry(entry);

    this.events.emit('entry_added', projectId, entry.id, { name: entry.name, category: entry.category });

    return entry;
  }

  getEntry(projectId, entryId) {
    this._assertProject(projectId);

    const filePath = this._entryPath(projectId, entryId);
    if (!fs.existsSync(filePath)) {
      throw new EntryNotFoundError(projectId, entryId);
    }

    const entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    entry._staleness = computeStaleness(entry);
    return entry;
  }

  updateEntry(projectId, entryId, changes) {
    this._assertProject(projectId);

    const filePath = this._entryPath(projectId, entryId);
    if (!fs.existsSync(filePath)) {
      throw new EntryNotFoundError(projectId, entryId);
    }

    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const updated = { ...existing, ...changes, updatedAt: now() };

    // Auto-set retiredAt when transitioning to retired
    if (changes.status === 'retired' && existing.status !== 'retired') {
      updated.retiredAt = updated.retiredAt || updated.updatedAt;
    }

    this._validate(updated);

    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));

    // Update manifest if name/category changed
    if (changes.name !== undefined || changes.category !== undefined) {
      const index = this._readIndex(projectId);
      const idx = index.entries.findIndex(e => e.id === entryId);
      if (idx !== -1) {
        index.entries[idx] = { id: entryId, name: updated.name, category: updated.category };
        this._writeIndex(projectId, index);
      }
    }

    // Re-index in SQLite
    this._indexEntry(updated);

    this.events.emit('entry_updated', projectId, entryId, { fields: Object.keys(changes) });

    // Additional event when retiring
    if (changes.status === 'retired' && existing.status !== 'retired') {
      this.events.emit('entry_retired', projectId, entryId, {});
    }

    return updated;
  }

  listEntries(projectId, filters = {}) {
    this._assertProject(projectId);

    const dir = this._projectDir(projectId);
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== '_index.json');
    let entries = files.map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));

    if (filters.status) {
      entries = entries.filter(e => e.status === filters.status);
    }
    if (filters.category) {
      entries = entries.filter(e => e.category === filters.category);
    }

    return entries;
  }

  // -------------------------------------------------------------------------
  // Search (FTS5 with LIKE fallback)
  // -------------------------------------------------------------------------
  search(projectId, query) {
    this._assertProject(projectId);

    // Try FTS5 first
    try {
      // Migration 008's entries_fts is standalone-content with `id UNINDEXED` —
      // fts.rowid is FTS5-internal and drifts from entries.rowid after any
      // backfill over a gapped entries table. Join on the explicit id column.
      const rows = this.db.prepare(`
        SELECT e.id, e.projectId FROM entries e
        JOIN entries_fts fts ON e.id = fts.id
        WHERE fts.entries_fts MATCH ? AND e.projectId = ?
        ORDER BY rank
      `).all(query, projectId);

      if (rows.length > 0) {
        return rows.map(r => {
          try {
            return this.getEntry(r.projectId, r.id);
          } catch (_) {
            return null;
          }
        }).filter(Boolean);
      }
    } catch (_) {
      // FTS5 MATCH can fail on certain queries — fall through to LIKE
    }

    // LIKE fallback
    const like = `%${query}%`;
    const rows = this.db.prepare(`
      SELECT id, projectId FROM entries
      WHERE projectId = ?
        AND (name LIKE ? OR description LIKE ? OR tags LIKE ?)
    `).all(projectId, like, like, like);

    return rows.map(r => {
      try {
        return this.getEntry(r.projectId, r.id);
      } catch (_) {
        return null;
      }
    }).filter(Boolean);
  }

  // -------------------------------------------------------------------------
  // Staleness helpers
  // -------------------------------------------------------------------------
  getStaleEntries(projectId) {
    this._assertProject(projectId);

    const entries = this.listEntries(projectId);
    return entries.filter(e => {
      const staleness = computeStaleness(e);
      return staleness.isStale;
    });
  }

  verifyEntry(projectId, entryId) {
    this._assertProject(projectId);

    const filePath = this._entryPath(projectId, entryId);
    if (!fs.existsSync(filePath)) {
      throw new EntryNotFoundError(projectId, entryId);
    }

    const entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    entry.confidence = entry.confidence || {};
    entry.confidence.lastVerified = now();
    entry.updatedAt = now();

    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2));
    this._indexEntry(entry);

    this.events.emit('entry_verified', projectId, entryId);

    return entry;
  }

  // -------------------------------------------------------------------------
  // rebuildIndex: recreate SQLite from JSON files on disk
  // -------------------------------------------------------------------------
  rebuildIndex() {
    this.db.exec(`
      DROP TABLE IF EXISTS relationships;
      DROP TABLE IF EXISTS entries;
    `);
    this._initDb();

    // Walk all project dirs
    const config = this._readConfig();
    for (const project of config.projects) {
      const dir = this._projectDir(project.id);
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== '_index.json');
      for (const f of files) {
        const entry = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        this._indexEntry(entry);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Relationship management
  // -------------------------------------------------------------------------
  addRelationship(fromProject, fromId, toProject, toId, type = 'related') {
    this.db.prepare(`
      INSERT OR REPLACE INTO relationships (fromProject, fromId, toProject, toId, type)
      VALUES (?, ?, ?, ?, ?)
    `).run(fromProject, fromId, toProject, toId, type);

    this.events.emit('relationship_created', fromProject, fromId, { toProject, toId, type });
  }

  getRelationships(projectId, entryId) {
    return this.db.prepare(`
      SELECT * FROM relationships
      WHERE (fromProject = ? AND fromId = ?) OR (toProject = ? AND toId = ?)
    `).all(projectId, entryId, projectId, entryId);
  }

  // -------------------------------------------------------------------------
  // Hub-local usage telemetry (entry_usage table)
  //
  // Per Q2 design override: these fields are NOT part of the MIF entry —
  // they are hub-computed and hub-policy-dependent. Different rerankers may
  // compute responseStrength differently; different hubs see different
  // interaction histories. Keeping them out of the signed payload avoids
  // the "every reranker tweak forces KB re-sign" trap.
  // -------------------------------------------------------------------------
  recordShown(projectId, id, at = now()) {
    this.db.prepare(`
      INSERT INTO entry_usage (projectId, id, lastShownAt, updatedAt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(projectId, id) DO UPDATE SET
        lastShownAt = excluded.lastShownAt,
        updatedAt   = excluded.updatedAt
    `).run(projectId, id, at, at);
  }

  recordUsed(projectId, id, responseStrength, at = now()) {
    this.db.prepare(`
      INSERT INTO entry_usage (projectId, id, lastUsedAt, responseStrength, updatedAt)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(projectId, id) DO UPDATE SET
        lastUsedAt       = excluded.lastUsedAt,
        responseStrength = excluded.responseStrength,
        updatedAt        = excluded.updatedAt
    `).run(projectId, id, at, responseStrength, at);
  }

  getUsage(projectId, id) {
    return this.db.prepare(
      'SELECT lastShownAt, lastUsedAt, responseStrength, updatedAt FROM entry_usage WHERE projectId = ? AND id = ?'
    ).get(projectId, id) || null;
  }

  // -------------------------------------------------------------------------
  // Close
  // -------------------------------------------------------------------------
  close() {
    if (this.db && this.db.open) {
      this.db.close();
    }
  }
}

module.exports = { KBStore };
