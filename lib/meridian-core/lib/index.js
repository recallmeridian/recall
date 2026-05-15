'use strict';

const { KBStore } = require('./kb-store');
const { EventLog } = require('./event-log');
const { QueryEngine, tokenize, computeTfIdf } = require('./query-engine');
const { GraphEngine } = require('./graph-engine');
const { computeStaleness, getDefaultDecayDays } = require('./staleness');
const { detectIdentifier } = require('../fetchers/doi-resolver');
const { fetchByPMID, pmidFromDOI } = require('../fetchers/pubmed');
const { fetchBioRxiv } = require('../fetchers/biorxiv');
const { fetchArxiv } = require('../fetchers/arxiv');
const { SemanticSearch, cosineSimilarity } = require('./semantic-search');
const { BM25Index, escapeFTS5Query } = require('./bm25-index');
const { rrfMerge, DEFAULT_K } = require('./rrf-merger');
// RERANK_DEFAULT_DECAY_DAYS is reranker's fixed freshness-factor constant; distinct from staleness's getDefaultDecayDays (a function returning staleness half-life).
const { rerank, DEFAULT_DECAY_DAYS: RERANK_DEFAULT_DECAY_DAYS, KIN_BOOST } = require('./reranker');
const { shapeResults, extractSnippet, computeSufficiency, TIER_BUDGETS, VALID_TIERS, VALID_FACETS, DEFAULT_FACETS } = require('./response-shaper');
const { CandidateCache } = require('./candidate-cache');
const { buildPrefilterSQL, ALLOWED_PREFILTER_FIELDS } = require('./prefilter');
const { GapsEngine } = require('./gaps');
const { SnapshotService } = require('./snapshot');
const { buildLocalRegistry } = require('./buildLocalRegistry');
const errors = require('./errors');

/**
 * init(dataDir) - Initialize a data directory and return a configured KBStore
 *
 * @param {string} [dataDir] - Optional data directory path. Defaults to ~/.meridian
 * @returns {KBStore} - Initialized store with attached query and graph engines
 */
function init(dataDir, opts = {}) {
  const path = require('path');
  const os = require('os');
  const dir = dataDir || path.join(os.homedir(), '.meridian');

  const store = new KBStore(dir);
  store.queryEngine = new QueryEngine(store.db);
  store.graphEngine = new GraphEngine(store.db);

  // Attach convenience methods
  store.query = (q) => store.queryEngine.query(q);
  store.findPath = (...args) => store.graphEngine.findPath(...args);
  store.getStats = () => store.graphEngine.getStats();

  // SemanticSearch is already initialized in KBStore constructor (store.semanticSearch).
  // Attach top-level convenience aliases for direct access.
  store.semanticFind = (q, opts2) => store.semanticSearch.search(q, opts2);
  store.hybridFind = (q, opts2) => store.semanticSearch.hybridSearch(q, opts2);

  // IRelationRepository slot — wraps the existing GraphEngine behind a typed
  // contract per the 2026-05-12 boundary audit. Lazy-instantiated; tests can
  // swap in a stub by overriding store.getRelationRepository directly.
  let _relationRepository = null;
  store.getRelationRepository = function getRelationRepository() {
    if (_relationRepository) return _relationRepository;
    const { GraphEngineRelationRepository } = require('../adapters/GraphEngineRelationRepository');
    _relationRepository = new GraphEngineRelationRepository({ graphEngine: store.graphEngine });
    return _relationRepository;
  };

  // Optional LLMProvider — configured at init time. Lazy-instantiated on first
  // getLlmProvider() call. Lets command-side adapters call store.getLlmProvider()
  // instead of importing OpenAICompatibleLLM directly (closes the audit finding
  // about direct adapter imports in commands).
  let _llmProvider = null;
  store.getLlmProvider = function getLlmProvider() {
    if (_llmProvider) return _llmProvider;
    const cfg = opts.llm || {};
    if (!cfg.baseUrl || !cfg.model) {
      throw new Error('LLMProvider not configured. Pass { llm: { provider, baseUrl, model, apiKey } } to meridian.init(), or run: recall llm config --provider <name> --base-url <url> --model <id>');
    }
    const { OpenAICompatibleLLM } = require('../adapters/OpenAICompatibleLLM');
    _llmProvider = new OpenAICompatibleLLM({
      provider: cfg.provider || 'openai-compatible',
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKey: cfg.apiKey || '',
    });
    return _llmProvider;
  };

  return store;
}

/**
 * fetch(identifier) - Fetch a paper from DOI, PMID, arXiv, or bioRxiv
 *
 * Auto-detects the identifier type and routes to the appropriate fetcher.
 * Tries multiple sources for ambiguous identifiers (e.g., DOI via PubMed then bioRxiv).
 *
 * @param {string} identifier - DOI, PMID, arXiv ID, URL, or bioRxiv DOI/URL
 * @returns {Promise<Object>} - Paper metadata { title, authors, abstract, ...}
 * @throws {Error} - If identifier cannot be resolved
 */
async function fetch(identifier) {
  const detected = detectIdentifier(identifier);

  switch (detected.type) {
    case 'pmid':
      return fetchByPMID(detected.id);
    case 'arxiv':
      return fetchArxiv(detected.id);
    case 'biorxiv':
      return fetchBioRxiv(detected.id);
    case 'doi': {
      const pmid = await pmidFromDOI(detected.id);
      if (pmid) return fetchByPMID(pmid);
      try { return await fetchBioRxiv(detected.id); }
      catch (e) { throw new Error(`Could not resolve DOI ${detected.id} via PubMed or bioRxiv`); }
    }
    default:
      throw new Error(`Unrecognized identifier format: "${identifier}". Expected DOI, PMID, arXiv ID, or URL.`);
  }
}

module.exports = {
  init,
  fetch,
  KBStore,
  EventLog,
  QueryEngine,
  GraphEngine,
  SemanticSearch,
  cosineSimilarity,
  computeStaleness,
  getDefaultDecayDays,
  detectIdentifier,
  tokenize,
  computeTfIdf,
  errors,
  BM25Index,
  escapeFTS5Query,
  rrfMerge,
  DEFAULT_K,
  rerank,
  RERANK_DEFAULT_DECAY_DAYS,
  KIN_BOOST,
  shapeResults,
  extractSnippet,
  computeSufficiency,
  TIER_BUDGETS,
  VALID_TIERS,
  VALID_FACETS,
  DEFAULT_FACETS,
  CandidateCache,
  buildPrefilterSQL,
  ALLOWED_PREFILTER_FIELDS,
  GapsEngine,
  SnapshotService,
  buildLocalRegistry,
};
