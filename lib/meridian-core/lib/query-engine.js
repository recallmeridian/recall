'use strict';

// ---------------------------------------------------------------------------
// Column map: user-facing field names → SQLite column names
// ---------------------------------------------------------------------------
const COLUMN_MAP = {
  // Direct mappings
  id: 'id',
  name: 'name',
  description: 'description',
  category: 'category',
  status: 'status',
  project: 'projectId',
  source: 'source',
  tags: 'tags',
  genes: 'genes',
  pathways: 'pathways',
  // snake_case
  disease_area: 'disease_area',
  confidence_score: 'confidence_score',
  evidence_level: 'evidence_level',
  is_negative_result: 'is_negative_result',
  added_at: 'addedAt',
  updated_at: 'updatedAt',
  // camelCase aliases
  diseaseArea: 'disease_area',
  confidenceScore: 'confidence_score',
  evidenceLevel: 'evidence_level',
  isNegativeResult: 'is_negative_result',
  addedAt: 'addedAt',
  updatedAt: 'updatedAt',
  projectId: 'projectId',
  profile: 'profile',
};

// Fields that are stored in the entries table
const DB_COLUMNS = new Set([
  'id', 'projectId', 'name', 'description', 'status', 'category',
  'tags', 'disease_area', 'genes', 'pathways', 'addedAt', 'updatedAt',
]);

/**
 * QueryEngine — SQL-like query interface over the KBStore SQLite database.
 *
 * Syntax:
 *   TABLE <fields> FROM <source> [WHERE <conditions>] [SORT <field> ASC|DESC] [LIMIT N]
 *
 * Examples:
 *   TABLE name, category FROM mechanism
 *   TABLE name FROM entries WHERE status = 'active'
 *   TABLE name FROM entries WHERE disease_area = 'pancreatic cancer' SORT name ASC LIMIT 10
 */
class QueryEngine {
  /**
   * @param {import('better-sqlite3').Database} db  The SQLite db instance from KBStore.db
   */
  constructor(db) {
    this.db = db;
  }

  // ---------------------------------------------------------------------------
  // _parse: parse query string into structured object
  // ---------------------------------------------------------------------------
  _parse(queryStr) {
    const str = queryStr.trim();

    // Must start with TABLE
    if (!/^TABLE\s/i.test(str)) {
      throw new Error(
        `Query must start with TABLE. Got: "${queryStr}"\n` +
        `Syntax: TABLE <fields> FROM <source> [WHERE <conditions>] [SORT <field> ASC|DESC] [LIMIT N]`
      );
    }

    // Extract LIMIT (must be last)
    let limit = null;
    let remaining = str;
    const limitMatch = remaining.match(/\bLIMIT\s+(\d+)\s*$/i);
    if (limitMatch) {
      limit = parseInt(limitMatch[1], 10);
      remaining = remaining.slice(0, limitMatch.index).trim();
    }

    // Extract SORT
    let sortField = null;
    let sortDir = 'ASC';
    const sortMatch = remaining.match(/\bSORT\s+(\w+)\s+(ASC|DESC)\s*$/i);
    if (sortMatch) {
      sortField = sortMatch[1];
      sortDir = sortMatch[2].toUpperCase();
      remaining = remaining.slice(0, sortMatch.index).trim();
    }

    // Extract WHERE
    let conditions = [];
    const whereMatch = remaining.match(/\bWHERE\s+(.+)$/i);
    if (whereMatch) {
      const condStr = whereMatch[1].trim();
      remaining = remaining.slice(0, whereMatch.index).trim();
      conditions = this._parseConditions(condStr);
    }

    // Extract FROM <source>
    const fromMatch = remaining.match(/\bFROM\s+(\S+)\s*$/i);
    if (!fromMatch) {
      throw new Error(
        `Missing FROM clause in query: "${queryStr}"\n` +
        `Syntax: TABLE <fields> FROM <source> [WHERE <conditions>] [SORT <field> ASC|DESC] [LIMIT N]`
      );
    }
    const source = fromMatch[1];
    remaining = remaining.slice(0, fromMatch.index).trim();

    // Extract fields list (after TABLE keyword)
    const tableMatch = remaining.match(/^TABLE\s+(.+)$/i);
    if (!tableMatch) {
      throw new Error(
        `Cannot parse fields in query: "${queryStr}"\n` +
        `Syntax: TABLE <fields> FROM <source>`
      );
    }
    const fieldsRaw = tableMatch[1].trim();
    const fields = fieldsRaw === '*'
      ? ['*']
      : fieldsRaw.split(',').map(f => f.trim()).filter(Boolean);

    return { fields, source, conditions, sortField, sortDir, limit };
  }

  // ---------------------------------------------------------------------------
  // _parseConditions: parse "field = 'value' AND field2 LIKE '%val%'"
  // ---------------------------------------------------------------------------
  _parseConditions(condStr) {
    const parts = condStr.split(/\bAND\b/i);
    return parts.map(part => {
      part = part.trim();

      // field LIKE 'value'
      const likeMatch = part.match(/^(\w+)\s+LIKE\s+'([^']*)'\s*$/i);
      if (likeMatch) {
        return { field: likeMatch[1], op: 'LIKE', value: likeMatch[2] };
      }

      // field != 'value'
      const neqMatch = part.match(/^(\w+)\s+!=\s+'([^']*)'\s*$/i);
      if (neqMatch) {
        return { field: neqMatch[1], op: '!=', value: neqMatch[2] };
      }

      // field = 'value'
      const eqMatch = part.match(/^(\w+)\s+=\s+'([^']*)'\s*$/i);
      if (eqMatch) {
        return { field: eqMatch[1], op: '=', value: eqMatch[2] };
      }

      throw new Error(`Cannot parse condition: "${part}"`);
    });
  }

  // ---------------------------------------------------------------------------
  // _resolveColumn: map field name to DB column name
  // ---------------------------------------------------------------------------
  _resolveColumn(field) {
    if (field === '*') return '*';
    const col = COLUMN_MAP[field];
    if (!col) {
      throw new Error(`Unknown field: "${field}". Check your column name.`);
    }
    return col;
  }

  // ---------------------------------------------------------------------------
  // _toSQL: build parameterized SQL from parsed query
  // ---------------------------------------------------------------------------
  _toSQL(parsed) {
    const { fields, source, conditions, sortField, sortDir, limit } = parsed;

    // Resolve SELECT columns
    let selectCols;
    if (fields.length === 1 && fields[0] === '*') {
      selectCols = '*';
    } else {
      const cols = fields.map(f => {
        const col = this._resolveColumn(f);
        // Only select columns that exist in the entries table
        if (!DB_COLUMNS.has(col)) {
          // Still include in select but it will be NULL for unknown columns
          return `NULL AS ${col}`;
        }
        // Alias back to user-facing name if camelCase was used
        return col === f ? col : `${col} AS ${col}`;
      });
      selectCols = cols.join(', ');
    }

    // Build WHERE clauses
    const whereParts = [];
    const params = [];

    // Source filter: if not "entries", treat as category or projectId
    if (source.toLowerCase() !== 'entries') {
      whereParts.push('(category = ? OR projectId = ?)');
      params.push(source, source);
    }

    // Condition filters
    for (const cond of conditions) {
      const col = this._resolveColumn(cond.field);
      if (!DB_COLUMNS.has(col)) {
        // Field not in DB — skip silently (would always be empty)
        whereParts.push('1=0');
        continue;
      }
      whereParts.push(`${col} ${cond.op} ?`);
      params.push(cond.value);
    }

    let sql = `SELECT ${selectCols} FROM entries`;
    if (whereParts.length > 0) {
      sql += ` WHERE ${whereParts.join(' AND ')}`;
    }

    // SORT
    if (sortField) {
      const sortCol = this._resolveColumn(sortField);
      sql += ` ORDER BY ${sortCol} ${sortDir}`;
    }

    // LIMIT
    if (limit !== null) {
      sql += ` LIMIT ${limit}`;
    }

    return { sql, params };
  }

  // ---------------------------------------------------------------------------
  // query: public API
  // ---------------------------------------------------------------------------
  query(queryStr) {
    const parsed = this._parse(queryStr);
    const { sql, params } = this._toSQL(parsed);

    const stmt = this.db.prepare(sql);
    return stmt.all(...params);
  }

  // ---------------------------------------------------------------------------
  // relevanceSearch: TF-IDF ranked search over entries
  // options: { project, category, limit }
  // ---------------------------------------------------------------------------
  relevanceSearch(query, options) {
    if (!options) options = {};
    const project = options.project;
    const category = options.category;
    const limit = options.limit || 20;

    const whereParts = [];
    const params = [];
    if (project) {
      whereParts.push('projectId = ?');
      params.push(project);
    }
    if (category) {
      whereParts.push('category = ?');
      params.push(category);
    }

    let sql = 'SELECT id, projectId, name, description, category, tags FROM entries';
    if (whereParts.length > 0) {
      sql += ' WHERE ' + whereParts.join(' AND ');
    }

    const rows = this.db.prepare(sql).all(...params);

    const documents = rows.map(row => {
      const text = [
        row.name || '',
        row.description || '',
        row.category || '',
        row.tags || '',
      ].join(' ');
      return Object.assign({}, row, {
        tokens: tokenize(text),
        confidence: null,
      });
    });

    const queryTokens = tokenize(query);
    const scored = computeTfIdf(queryTokens, documents);

    return scored
      .slice(0, limit)
      .map(function(s) {
        return Object.assign({}, rows[s.index], { _relevanceScore: s.score });
      });
  }

  // ---------------------------------------------------------------------------
  // getRelatedEntries: find entries with most token overlap to a source entry
  // ---------------------------------------------------------------------------
  getRelatedEntries(entryId, limit) {
    if (limit === undefined) limit = 10;

    const source = this.db.prepare(
      'SELECT id, projectId, name, description, category, tags FROM entries WHERE id = ?'
    ).get(entryId);

    if (!source) return [];

    const sourceText = [source.name || '', source.description || ''].join(' ');
    const sourceTokens = new Set(tokenize(sourceText));

    if (sourceTokens.size === 0) return [];

    const rows = this.db.prepare(
      'SELECT id, projectId, name, description, category, tags FROM entries WHERE id != ?'
    ).all(entryId);

    const scored = rows.map(row => {
      const text = [row.name || '', row.description || '', row.category || '', row.tags || ''].join(' ');
      const tokens = tokenize(text);
      let overlap = 0;
      for (const t of tokens) {
        if (sourceTokens.has(t)) overlap++;
      }
      return { row: row, overlap: overlap };
    }).filter(function(s) { return s.overlap > 0; });

    scored.sort((a, b) => b.overlap - a.overlap);

    return scored
      .slice(0, limit)
      .map(function(s) {
        return Object.assign({}, s.row, { _overlapScore: s.overlap });
      });
  }
}

// ---------------------------------------------------------------------------
// TF-IDF: STOPWORDS, tokenize, computeTfIdf
// ---------------------------------------------------------------------------
const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','shall','can',
  'in','on','at','to','for','of','with','by','from','as','into','through','during',
  'before','after','above','below','between','out','off','over','under','again',
  'further','then','once','here','there','when','where','why','how','all','each',
  'every','both','few','more','most','other','some','such','no','nor','not','only',
  'own','same','so','than','too','very','and','but','or','if','while','that','this',
  'these','those','it','its','they','them','their','we','our','he','she','his','her',
  'which','what','who','whom','about','also','just','using','used','based','two',
]);

function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text.toLowerCase().replace(/[^a-z0-9\s\-]/g, ' ').split(/\s+/).filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

function computeTfIdf(queryTokens, documents) {
  const N = documents.length;
  if (N === 0 || queryTokens.length === 0) return [];

  // Document frequency
  const df = {};
  for (const doc of documents) {
    const seen = new Set();
    for (const term of doc.tokens) {
      if (!seen.has(term)) { df[term] = (df[term] || 0) + 1; seen.add(term); }
    }
  }

  const scores = [];
  for (let i = 0; i < N; i++) {
    const doc = documents[i];
    if (doc.tokens.length === 0) continue;

    const tf = {};
    for (const term of doc.tokens) { tf[term] = (tf[term] || 0) + 1; }

    let score = 0;
    for (const qterm of queryTokens) {
      if (!tf[qterm]) continue;
      const termFreq = tf[qterm] / doc.tokens.length;
      const invDocFreq = Math.log(N / (1 + (df[qterm] || 0)));
      score += termFreq * invDocFreq;
    }

    // Name boost: 1.5x
    const nameLower = (doc.name || '').toLowerCase();
    for (const qterm of queryTokens) {
      if (nameLower.includes(qterm)) score *= 1.5;
    }

    // Confidence-aware ranking
    let confidence = doc.confidence;
    if (confidence != null && typeof confidence === 'number') {
      if (confidence > 1) confidence = confidence / 100;
      score *= Math.max(confidence, 0.1);
    }

    if (score > 0) scores.push({ index: i, score });
  }

  scores.sort((a, b) => b.score - a.score);
  return scores;
}

module.exports = { QueryEngine, tokenize, computeTfIdf };
