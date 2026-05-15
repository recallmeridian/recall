'use strict';

/**
 * semantic-search.js — Embedding-based semantic search for Meridian.
 *
 * Uses OpenAI-compatible embedding API (set OPENAI_API_KEY or VOYAGE_API_KEY).
 * Falls back gracefully when no API key is available.
 *
 * Based on HyDE (Gao et al. 2022): hypothetical doc embeddings for zero-shot retrieval.
 */

const https = require('https');

const EMBEDDING_MODEL = 'text-embedding-3-small'; // OpenAI small model, 1536 dims
const EMBEDDING_DIM = 1536;

class SemanticSearch {
  constructor(db, options = {}) {
    this.db = db;
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY || process.env.VOYAGE_API_KEY || '';
    this.baseUrl = options.baseUrl || 'https://api.openai.com/v1';
    this._initTable();
  }

  _initTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        entry_id TEXT NOT NULL,
        project TEXT NOT NULL,
        embedding BLOB NOT NULL,
        model TEXT DEFAULT '${EMBEDDING_MODEL}',
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (entry_id, project)
      );
    `);
  }

  isAvailable() {
    return !!this.apiKey;
  }

  /**
   * Get embedding from OpenAI API.
   * @param {string} text
   * @returns {Promise<number[]>}
   */
  async _embed(text) {
    if (!this.apiKey) throw new Error('No embedding API key configured');

    const body = JSON.stringify({
      input: text.slice(0, 8000), // limit input length
      model: EMBEDDING_MODEL,
    });

    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + '/embeddings');
      const reqOptions = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) reject(new Error(parsed.error.message));
            else resolve(parsed.data[0].embedding);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * Index a single entry — compute and store its embedding.
   * @param {Object} entry - Entry object with id, name, description, category, tags, projectId
   * @returns {Promise<{id: string, dimensions: number}>}
   */
  async indexEntry(entry) {
    const text = [
      entry.name || '',
      entry.description || '',
      entry.category || '',
      Array.isArray(entry.tags) ? entry.tags.join(' ') : (entry.tags || ''),
      entry.disease_area || '',
    ].join(' ');

    const embedding = await this._embed(text);
    const buffer = Buffer.from(new Float32Array(embedding).buffer);
    const project = entry.projectId || entry.project || '';

    this.db.prepare(`
      INSERT OR REPLACE INTO embeddings (entry_id, project, embedding, model)
      VALUES (?, ?, ?, ?)
    `).run(entry.id, project, buffer, EMBEDDING_MODEL);

    return { id: entry.id, dimensions: embedding.length };
  }

  /**
   * Index all entries in a project.
   * @param {string} project
   * @param {Function} [progressCallback] - Called with (indexed, total) after each entry
   * @returns {Promise<{indexed: number, total: number}>}
   */
  async indexAll(project, progressCallback) {
    const entries = this.db.prepare(
      'SELECT id, name, description, category, tags, disease_area, projectId FROM entries WHERE projectId = ?'
    ).all(project);

    let indexed = 0;
    for (const entry of entries) {
      try {
        const text = [
          entry.name || '',
          entry.description || '',
          entry.category || '',
          entry.tags || '',
          entry.disease_area || '',
        ].join(' ');

        const embedding = await this._embed(text);
        const buffer = Buffer.from(new Float32Array(embedding).buffer);

        this.db.prepare(`
          INSERT OR REPLACE INTO embeddings (entry_id, project, embedding, model)
          VALUES (?, ?, ?, ?)
        `).run(entry.id, project, buffer, EMBEDDING_MODEL);

        indexed++;
        if (progressCallback) progressCallback(indexed, entries.length);
      } catch (_) {
        // Skip entries that fail to embed — non-fatal
      }
    }

    return { indexed, total: entries.length };
  }

  /**
   * Semantic search — find entries by embedding similarity.
   * @param {string} query
   * @param {Object} [options]
   * @param {string} [options.project]
   * @param {number} [options.limit=20]
   * @param {number} [options.threshold=0.3]
   * @returns {Promise<Object[]>}
   */
  async search(query, options = {}) {
    const { project, limit = 20, threshold = 0.3 } = options;

    // Embed the query
    const queryEmbedding = await this._embed(query);

    // Load all embeddings from DB
    const stmt = project
      ? this.db.prepare('SELECT entry_id, embedding FROM embeddings WHERE project = ?')
      : this.db.prepare('SELECT entry_id, embedding FROM embeddings');
    const rows = project ? stmt.all(project) : stmt.all();

    // Compute cosine similarity for each
    const results = [];
    for (const row of rows) {
      const stored = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4
      );
      const similarity = cosineSimilarity(queryEmbedding, stored);
      if (similarity > threshold) {
        results.push({ entryId: row.entry_id, _cosineSimilarity: similarity });
      }
    }

    results.sort((a, b) => b._cosineSimilarity - a._cosineSimilarity);

    // Enrich with entry data
    const enriched = [];
    for (const r of results.slice(0, limit)) {
      const entry = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(r.entryId);
      if (entry) {
        enriched.push({
          ...entry,
          _cosineSimilarity: Math.round(r._cosineSimilarity * 10000) / 10000,
          _semanticScore: Math.round(r._cosineSimilarity * 10000) / 10000,
        });
      }
    }

    return enriched;
  }

  /**
   * Dense-retrieval rank list — returns a bare {id, score, rank} list with NO
   * threshold applied. Pre-RRF stage (Plan 1D Task 4): the merger needs the
   * full top-k to compute reciprocal ranks, so filtering low-similarity hits
   * here would corrupt the fusion.
   *
   * @param {string} query
   * @param {Object} [options]
   * @param {number} [options.limit=50]
   * @param {string|null} [options.project]
   * @returns {Promise<Array<{id: string, score: number, rank: number}>>}
   *   Ranked by cosine similarity descending; rank is 1-indexed.
   *   Returns [] when no API key is configured (graceful degradation).
   */
  async denseRank(query, { limit = 50, project = null } = {}) {
    if (!this.apiKey) return [];

    const queryEmbedding = await this._embed(query);

    const rows = project
      ? this.db.prepare('SELECT entry_id, embedding FROM embeddings WHERE project = ?').all(project)
      : this.db.prepare('SELECT entry_id, embedding FROM embeddings').all();

    const scored = rows.map((row) => {
      const stored = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4
      );
      return { id: row.entry_id, score: cosineSimilarity(queryEmbedding, stored) };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((r, i) => ({ id: r.id, score: r.score, rank: i + 1 }));
  }

  /**
   * Hybrid search — combine semantic + TF-IDF + confidence.
   * Score = 0.5 * semantic + 0.3 * tfidf + 0.2 * confidence
   * @param {string} query
   * @param {Object} [options]
   * @param {string} [options.project]
   * @param {number} [options.limit=20]
   * @returns {Promise<Object[]>}
   * @deprecated removed in Plan 2A; use denseRank() + RRF merger
   */
  async hybridSearch(query, options = {}) {
    const { project, limit = 20 } = options;

    // Get semantic results (fetch more candidates for blending)
    const semanticResults = await this.search(query, { project, limit: 50 });
    const semanticMap = new Map();
    const maxSemantic = semanticResults.length > 0 ? semanticResults[0]._cosineSimilarity : 1;
    for (const r of semanticResults) {
      semanticMap.set(r.id, r._cosineSimilarity / (maxSemantic || 1));
    }

    // Get all candidates for TF-IDF scoring
    const stmt = project
      ? this.db.prepare('SELECT * FROM entries WHERE projectId = ?')
      : this.db.prepare('SELECT * FROM entries');
    const candidates = project ? stmt.all(project) : stmt.all();

    // Compute TF-IDF scores
    const { tokenize, computeTfIdf } = require('./query-engine');
    const queryTokens = tokenize(query);
    const documents = candidates.map(e => ({
      tokens: tokenize([e.name || '', e.description || '', e.category || '', e.tags || ''].join(' ')),
      name: e.name,
      confidence: e.confidence_score,
    }));

    const tfidfScores = computeTfIdf(queryTokens, documents);
    const tfidfMap = new Map();
    const maxTfidf = tfidfScores.length > 0 ? tfidfScores[0].score : 1;
    for (const s of tfidfScores) {
      tfidfMap.set(candidates[s.index].id, s.score / (maxTfidf || 1));
    }

    // Combine: seed with all candidates, enrich with semantic + tfidf scores where available
    const candidateById = new Map(candidates.map(e => [e.id, e]));
    const allIds = new Set(candidates.map(e => e.id));
    // Also add any semantic hits that may not be in the candidate list (cross-project edge case)
    for (const id of semanticMap.keys()) allIds.add(id);

    const hybrid = [];
    for (const id of allIds) {
      const semantic = semanticMap.get(id) || 0;
      const tfidf = tfidfMap.get(id) || 0;
      const entry = candidateById.get(id);
      const rawConf = entry ? (entry.confidence_score || 0.5) : 0.5;
      const confidence = Math.min(rawConf > 1 ? rawConf / 100 : rawConf, 1);

      const score = 0.5 * semantic + 0.3 * tfidf + 0.2 * confidence;
      hybrid.push({
        ...entry,
        _hybridScore: Math.round(score * 10000) / 10000,
        _semanticScore: Math.round(semantic * 10000) / 10000,
        _tfidfScore: Math.round(tfidf * 10000) / 10000,
      });
    }

    hybrid.sort((a, b) => b._hybridScore - a._hybridScore);
    return hybrid.slice(0, limit);
  }
}

/**
 * Cosine similarity between two vectors.
 * @param {number[]|Float32Array} a
 * @param {number[]|Float32Array} b
 * @returns {number} similarity in [-1, 1]
 */
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

module.exports = { SemanticSearch, cosineSimilarity };
