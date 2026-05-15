'use strict';

const { randomUUID } = require('node:crypto');
const meridian = require('./meridian-core');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createMcpExpressApp } = require('@modelcontextprotocol/sdk/server/express.js');
const { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } = require('@modelcontextprotocol/sdk/server/auth/router.js');
const { requireBearerAuth } = require('@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const z = require('zod/v4');
const pkg = require('../package.json');
const { getDataDir } = require('./cli-config');
const {
  buildTimeline,
  filterEntriesAsOf,
  normalizeTemporalMetadata,
} = require('./temporal-memory');

const DEFAULT_LIMIT = 10;
const DEFAULT_ALLOWED_HTTP_HOSTS = [
  '127.0.0.1',
  'localhost',
  'mcp.recallmeridian.com',
  'chatgpt-mcp.recallmeridian.com',
  'grok-mcp.recallmeridian.com',
];
const DEFAULT_PUBLIC_MCP_URL = 'https://chatgpt-mcp.recallmeridian.com/mcp';
const OAUTH_SCOPE = 'mcp:tools';
const DEFAULT_STATIC_OAUTH_CLIENT_ID = 'recall-grok-mcp';
const DEFAULT_STATIC_OAUTH_REDIRECT_URIS = [
  'https://grok.com/oauth/callback',
  'https://grok.com/connectors/oauth/callback',
  'https://x.ai/oauth/callback',
];

function getClientSurface() {
  return process.env.RECALL_MCP_CLIENT || 'recall-mcp';
}

function getAllowedHttpHosts() {
  const configured = process.env.RECALL_MCP_ALLOWED_HOSTS;
  if (!configured) return DEFAULT_ALLOWED_HTTP_HOSTS;
  return configured.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getMcpAuthMode() {
  return (process.env.RECALL_MCP_AUTH_MODE || 'none').toLowerCase();
}

function getPublicMcpUrl() {
  return process.env.RECALL_MCP_PUBLIC_URL || DEFAULT_PUBLIC_MCP_URL;
}

function getStaticOAuthClientId() {
  return process.env.RECALL_MCP_STATIC_CLIENT_ID || DEFAULT_STATIC_OAUTH_CLIENT_ID;
}

function getStaticOAuthRedirectUris() {
  const configured = process.env.RECALL_MCP_STATIC_REDIRECT_URIS;
  if (!configured) return DEFAULT_STATIC_OAUTH_REDIRECT_URIS;
  return configured.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

class RecallOAuthClientsStore {
  constructor() {
    this.clients = new Map();
    const staticClientId = getStaticOAuthClientId();
    if (staticClientId) {
      this.clients.set(staticClientId, {
        client_id: staticClientId,
        client_id_issued_at: 0,
        client_name: 'Recall Grok MCP',
        redirect_uris: getStaticOAuthRedirectUris(),
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
    }
  }

  async getClient(clientId) {
    return this.clients.get(clientId);
  }

  async registerClient(clientMetadata) {
    this.clients.set(clientMetadata.client_id, clientMetadata);
    return clientMetadata;
  }
}

class RecallOAuthProvider {
  constructor() {
    this.clientsStore = new RecallOAuthClientsStore();
    this.codes = new Map();
    this.tokens = new Map();
  }

  async authorize(client, params, res) {
    const code = randomUUID();
    this.codes.set(code, { client, params });
    const target = new URL(params.redirectUri);
    target.searchParams.set('code', code);
    if (params.state !== undefined) target.searchParams.set('state', params.state);
    res.redirect(target.toString());
  }

  async challengeForAuthorizationCode(_client, authorizationCode) {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) throw new Error('Invalid authorization code');
    return codeData.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, resource) {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) throw new Error('Invalid authorization code');
    if (codeData.client.client_id !== client.client_id) {
      throw new Error('Authorization code was not issued to this client');
    }
    if (redirectUri && redirectUri !== codeData.params.redirectUri) {
      throw new Error('redirect_uri does not match authorization request');
    }
    const expectedResource = getPublicMcpUrl();
    const requestedResource = resource || codeData.params.resource;
    if (requestedResource && requestedResource.toString() !== expectedResource) {
      throw new Error(`Invalid resource: ${requestedResource}`);
    }

    this.codes.delete(authorizationCode);
    const token = randomUUID();
    const refreshToken = randomUUID();
    const scopes = codeData.params.scopes && codeData.params.scopes.length
      ? codeData.params.scopes
      : [OAUTH_SCOPE];
    const tokenData = {
      token,
      refreshToken,
      clientId: client.client_id,
      scopes,
      expiresAt: Date.now() + 60 * 60 * 1000,
      resource: requestedResource,
    };
    this.tokens.set(token, tokenData);
    this.tokens.set(refreshToken, { ...tokenData, token: refreshToken, accessToken: token });
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const refreshData = this.tokens.get(refreshToken);
    if (!refreshData || refreshData.clientId !== client.client_id) {
      throw new Error('Invalid refresh token');
    }
    const token = randomUUID();
    const nextScopes = scopes && scopes.length ? scopes : refreshData.scopes;
    const tokenData = {
      token,
      refreshToken,
      clientId: client.client_id,
      scopes: nextScopes,
      expiresAt: Date.now() + 60 * 60 * 1000,
      resource: resource || refreshData.resource,
    };
    this.tokens.set(token, tokenData);
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: nextScopes.join(' '),
    };
  }

  async verifyAccessToken(token) {
    const tokenData = this.tokens.get(token);
    if (!tokenData || tokenData.accessToken || tokenData.expiresAt < Date.now()) {
      throw new Error('Invalid or expired token');
    }
    return {
      token,
      clientId: tokenData.clientId,
      scopes: tokenData.scopes,
      expiresAt: Math.floor(tokenData.expiresAt / 1000),
      resource: tokenData.resource,
    };
  }

  async revokeToken(_client, token) {
    this.tokens.delete(token);
  }
}

function withKb(fn) {
  const kb = meridian.init(getDataDir());
  try {
    return fn(kb);
  } finally {
    kb.close();
  }
}

function compactEntry(entry) {
  if (!entry) return null;
  const temporal = normalizeTemporalMetadata(entry);
  return {
    id: entry.id,
    projectId: entry.projectId,
    name: entry.name,
    category: entry.category,
    status: entry.status,
    description: entry.description,
    source: entry.source,
    sourceUrl: entry.sourceUrl,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    practicalValue: entry.practicalValue,
    confidence: entry.confidence,
    updatedAt: entry.updatedAt,
    temporal,
  };
}

function textResult(message, structuredContent) {
  return {
    structuredContent,
    content: [{ type: 'text', text: message }],
  };
}

function normalizeLimit(limit) {
  const parsed = Number(limit || DEFAULT_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(50, Math.floor(parsed)));
}

function temporalArgs(args = {}) {
  const temporal = {};
  if (args.valid_from !== undefined) temporal.valid_from = args.valid_from;
  if (args.valid_to !== undefined) temporal.valid_to = args.valid_to;
  if (args.valid_time_source !== undefined) temporal.valid_time_source = args.valid_time_source;
  if (args.valid_time_confidence !== undefined) temporal.valid_time_confidence = args.valid_time_confidence;
  if (args.supersedes !== undefined) temporal.supersedes = args.supersedes;
  if (args.superseded_by !== undefined) temporal.superseded_by = args.superseded_by;
  if (args.evidence_refs !== undefined) temporal.evidence_refs = args.evidence_refs;
  return temporal;
}

function hasTemporalArgs(args = {}) {
  return Object.keys(temporalArgs(args)).length > 0;
}

function registerRecallTools(server) {
  server.registerTool('recall_status', {
    title: 'Recall Status',
    description: 'Inspect the local Recall data directory and project counts.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => withKb((kb) => {
    const projects = kb.listProjects();
    const projectCounts = projects.map((project) => ({
      id: project.id,
      name: project.name,
      entries: kb.listEntries(project.id).length,
    }));
    return textResult(`Recall is available with ${projects.length} project(s).`, {
      dataDir: getDataDir(),
      projects: projectCounts,
      writableTools: [
        'recall_add_entry',
        'recall_update_entry',
        'recall_retire_entry',
      ],
      temporalTools: [
        'recall_query_as_of',
        'recall_kb_timeline',
      ],
    });
  }));

  server.registerTool('recall_projects', {
    title: 'List Recall Projects',
    description: 'List local Recall projects available to the MCP client.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => withKb((kb) => {
    const projects = kb.listProjects();
    return textResult(`Found ${projects.length} Recall project(s).`, { projects });
  }));

  server.registerTool('recall_browse', {
    title: 'Browse Recall Entries',
    description: 'Browse entries in a Recall project with optional status and category filters.',
    inputSchema: {
      project_id: z.string().describe('Recall project id, such as research.'),
      status: z.enum(['active', 'draft', 'retired']).optional(),
      category: z.string().optional(),
      as_of: z.string().optional().describe('Optional ISO date/time for valid-time filtering.'),
      require_certain_valid_time: z.boolean().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ project_id, status, category, as_of, require_certain_valid_time, limit }) => withKb((kb) => {
    const filters = {};
    if (status) filters.status = status;
    if (category) filters.category = category;
    let rawEntries = kb.listEntries(project_id, filters);
    let temporalSummary = null;
    if (as_of) {
      temporalSummary = filterEntriesAsOf(rawEntries, {
        asOf: as_of,
        requireCertainValidTime: require_certain_valid_time === true,
      });
      rawEntries = temporalSummary.entries;
    }
    const entries = rawEntries.slice(0, normalizeLimit(limit)).map(compactEntry);
    return textResult(`Found ${entries.length} Recall entr${entries.length === 1 ? 'y' : 'ies'}.`, {
      as_of: as_of || null,
      entries,
      temporalSummary: temporalSummary ? {
        excluded: temporalSummary.excluded.length,
        abstentions: temporalSummary.abstentions.length,
      } : null,
    });
  }));

  server.registerTool('recall_get', {
    title: 'Fetch Recall Entry',
    description: 'Fetch one full Recall entry by project id and entry id.',
    inputSchema: {
      project_id: z.string().describe('Recall project id.'),
      entry_id: z.string().describe('Recall entry id.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ project_id, entry_id }) => withKb((kb) => {
    const entry = kb.getEntry(project_id, entry_id);
    return textResult(`Fetched Recall entry ${entry.id}.`, { entry });
  }));

  server.registerTool('recall_search', {
    title: 'Search Recall',
    description: 'Search local Recall entries in one project.',
    inputSchema: {
      project_id: z.string().describe('Recall project id.'),
      query: z.string().min(1).describe('Search query.'),
      as_of: z.string().optional().describe('Optional ISO date/time for valid-time filtering.'),
      require_certain_valid_time: z.boolean().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ project_id, query, as_of, require_certain_valid_time, limit }) => withKb((kb) => {
    let rawEntries = kb.search(project_id, query);
    let temporalSummary = null;
    if (as_of) {
      temporalSummary = filterEntriesAsOf(rawEntries, {
        asOf: as_of,
        requireCertainValidTime: require_certain_valid_time === true,
      });
      rawEntries = temporalSummary.entries;
    }
    const entries = rawEntries.slice(0, normalizeLimit(limit)).map(compactEntry);
    return textResult(`Found ${entries.length} Recall search result(s).`, {
      query,
      as_of: as_of || null,
      entries,
      temporalSummary: temporalSummary ? {
        excluded: temporalSummary.excluded.length,
        abstentions: temporalSummary.abstentions.length,
      } : null,
    });
  }));

  server.registerTool('recall_query_as_of', {
    title: 'Recall Query As Of',
    description: 'Return Recall entries that were valid as of a specific date/time.',
    inputSchema: {
      project_id: z.string().describe('Recall project id.'),
      as_of: z.string().describe('ISO date/time to query valid-time state.'),
      query: z.string().optional().describe('Optional text query to search before temporal filtering.'),
      status: z.enum(['active', 'draft', 'retired']).optional(),
      category: z.string().optional(),
      require_certain_valid_time: z.boolean().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ project_id, as_of, query, status, category, require_certain_valid_time, limit }) => withKb((kb) => {
    const filters = {};
    if (status) filters.status = status;
    if (category) filters.category = category;
    const candidates = query
      ? kb.search(project_id, query)
      : kb.listEntries(project_id, filters);
    const temporalSummary = filterEntriesAsOf(candidates, {
      asOf: as_of,
      requireCertainValidTime: require_certain_valid_time === true,
    });
    const entries = temporalSummary.entries.slice(0, normalizeLimit(limit)).map(compactEntry);
    return textResult(`Found ${entries.length} Recall entr${entries.length === 1 ? 'y' : 'ies'} valid as of ${as_of}.`, {
      project_id,
      query: query || null,
      as_of,
      entries,
      excluded: temporalSummary.excluded.map((decision) => ({
        entryId: decision.temporal.entryId,
        decision: decision.decision,
        reasons: decision.reasons,
      })),
      abstentions: temporalSummary.abstentions.map((decision) => ({
        entryId: decision.temporal.entryId,
        decision: decision.decision,
        reasons: decision.reasons,
      })),
    });
  }));

  server.registerTool('recall_kb_timeline', {
    title: 'Recall KB Timeline',
    description: 'Return the temporal version chain for a Recall entry using supersedes/superseded_by links.',
    inputSchema: {
      project_id: z.string().describe('Recall project id.'),
      entry_id: z.string().describe('Recall entry id.'),
      include_entries: z.boolean().optional().describe('Include compact entry metadata for each version.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ project_id, entry_id, include_entries }) => withKb((kb) => {
    const entries = kb.listEntries(project_id, {});
    const timeline = buildTimeline(entries, entry_id);
    const versions = timeline.versions.map((version) => ({
      entryId: version.entry.id,
      name: version.entry.name,
      temporal: version.temporal,
      supersedes: version.supersedes,
      superseded_by: version.superseded_by,
      entry: include_entries ? compactEntry(version.entry) : undefined,
    }));
    return textResult(`Found ${versions.length} temporal version(s) for ${entry_id}.`, {
      project_id,
      entry_id,
      foundTarget: timeline.foundTarget,
      warnings: timeline.warnings,
      versions,
    });
  }));

  server.registerTool('recall_add_entry', {
    title: 'Add Recall Entry',
    description: 'Create a new local Recall entry. Use draft status for unreviewed AI output.',
    inputSchema: {
      project_id: z.string().describe('Recall project id.'),
      name: z.string().min(1),
      description: z.string().min(1),
      category: z.string().min(1),
      status: z.enum(['active', 'draft']).default('draft'),
      tags: z.array(z.string()).optional(),
      source: z.string().optional(),
      source_url: z.string().url().optional(),
      practical_value: z.enum(['high', 'medium', 'low', 'unrated']).default('unrated'),
      valid_from: z.string().optional(),
      valid_to: z.string().nullable().optional(),
      valid_time_source: z.enum(['explicit', 'inferred_from_added_at', 'inferred_from_evidence', 'unknown']).optional(),
      valid_time_confidence: z.number().min(0).max(1).optional(),
      supersedes: z.array(z.string()).optional(),
      superseded_by: z.array(z.string()).optional(),
      evidence_refs: z.array(z.string()).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (args) => withKb((kb) => {
    const entry = kb.addEntry(args.project_id, {
      name: args.name,
      description: args.description,
      category: args.category,
      status: args.status || 'draft',
      tags: args.tags || [],
      source: args.source || 'ChatGPT',
      ...(args.source_url ? { sourceUrl: args.source_url } : {}),
      practicalValue: args.practical_value || 'unrated',
      confidence: {
        value: 0.35,
        lastVerified: new Date().toISOString(),
        decayDays: 30,
        exempt: false,
        verificationStatus: 'unverified',
      },
      fusion: { fusedFrom: [], fusedAt: null, fusionDepth: 0 },
      _extensions: {
        sourceSurface: getClientSurface(),
        capturedAt: new Date().toISOString(),
        ...(hasTemporalArgs(args) ? { temporal: temporalArgs(args) } : {}),
      },
    });
    return textResult(`Added Recall entry ${entry.id} as ${entry.status}.`, { entry: compactEntry(entry) });
  }));

  server.registerTool('recall_update_entry', {
    title: 'Update Recall Entry',
    description: 'Update editable fields on a local Recall entry.',
    inputSchema: {
      project_id: z.string(),
      entry_id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      category: z.string().optional(),
      status: z.enum(['active', 'draft', 'retired']).optional(),
      tags: z.array(z.string()).optional(),
      source: z.string().optional(),
      source_url: z.string().url().optional(),
      practical_value: z.enum(['high', 'medium', 'low', 'unrated']).optional(),
      valid_from: z.string().optional(),
      valid_to: z.string().nullable().optional(),
      valid_time_source: z.enum(['explicit', 'inferred_from_added_at', 'inferred_from_evidence', 'unknown']).optional(),
      valid_time_confidence: z.number().min(0).max(1).optional(),
      supersedes: z.array(z.string()).optional(),
      superseded_by: z.array(z.string()).optional(),
      evidence_refs: z.array(z.string()).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (args) => withKb((kb) => {
    const changes = {};
    if (args.name !== undefined) changes.name = args.name;
    if (args.description !== undefined) changes.description = args.description;
    if (args.category !== undefined) changes.category = args.category;
    if (args.status !== undefined) changes.status = args.status;
    if (args.tags !== undefined) changes.tags = args.tags;
    if (args.source !== undefined) changes.source = args.source;
    if (args.source_url !== undefined) changes.sourceUrl = args.source_url;
    if (args.practical_value !== undefined) changes.practicalValue = args.practical_value;
    if (hasTemporalArgs(args)) {
      const existing = kb.getEntry(args.project_id, args.entry_id);
      changes._extensions = {
        ...(existing._extensions || {}),
        temporal: {
          ...((existing._extensions && existing._extensions.temporal) || {}),
          ...temporalArgs(args),
        },
      };
    }
    const entry = kb.updateEntry(args.project_id, args.entry_id, changes);
    return textResult(`Updated Recall entry ${entry.id}.`, { entry: compactEntry(entry) });
  }));

  server.registerTool('recall_retire_entry', {
    title: 'Retire Recall Entry',
    description: 'Soft-delete a Recall entry by marking it retired.',
    inputSchema: {
      project_id: z.string(),
      entry_id: z.string(),
      reason: z.string().optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async ({ project_id, entry_id, reason }) => withKb((kb) => {
    const entry = kb.updateEntry(project_id, entry_id, {
      status: 'retired',
      _extensions: {
        ...(kb.getEntry(project_id, entry_id)._extensions || {}),
        retiredVia: getClientSurface(),
        retiredReason: reason || '',
      },
    });
    return textResult(`Retired Recall entry ${entry.id}.`, { entry: compactEntry(entry) });
  }));

  server.registerTool('recall_mcp_diagnostics', {
    title: 'Recall MCP Diagnostics',
    description: 'Report the writable Recall MCP connector identity and available tool surface.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => textResult('Recall MCP diagnostics are available.', {
    server: 'recall-mcp',
    version: pkg.version,
    transport: process.env.RECALL_MCP_TRANSPORT || 'unknown',
    clientSurface: getClientSurface(),
    endpoint: process.env.RECALL_MCP_TRANSPORT === 'streamable-http' ? '/mcp' : 'stdio',
    dataDir: getDataDir(),
    notes: [
      'The ChatGPT app connector surface may expose a separate read-only Recall fetch tool.',
      'This server is the writable local Recall MCP connector for desktop MCP clients.',
    ],
  }));

  // Compatibility tools for ChatGPT data-only app discovery and citation flows.
  server.registerTool('search', {
    title: 'Search Recall Entries',
    description: 'Compatibility search tool. Searches Recall and returns citation-style result handles.',
    inputSchema: {
      query: z.string().min(1),
      project_id: z.string().default('research'),
      limit: z.number().int().min(1).max(20).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ query, project_id, limit }) => withKb((kb) => {
    const results = kb.search(project_id, query).slice(0, normalizeLimit(limit)).map((entry) => ({
      id: `${entry.projectId}:${entry.id}`,
      title: entry.name,
      url: entry.sourceUrl || `recall://${entry.projectId}/entries/${entry.id}`,
    }));
    return {
      content: [{ type: 'text', text: JSON.stringify({ results }) }],
      structuredContent: { results },
    };
  }));

  server.registerTool('fetch', {
    title: 'Fetch Recall Search Result',
    description: 'Compatibility fetch tool. Fetches a Recall entry by a search result id like project:entry-id.',
    inputSchema: {
      id: z.string().describe('Search result id, usually project_id:entry_id.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ id }) => withKb((kb) => {
    const [projectId, ...entryParts] = id.split(':');
    const entryId = entryParts.join(':');
    if (!projectId || !entryId) {
      throw new Error('Fetch id must use project_id:entry_id format.');
    }
    const entry = kb.getEntry(projectId, entryId);
    const payload = {
      id,
      title: entry.name,
      text: entry.description,
      url: entry.sourceUrl || `recall://${entry.projectId}/entries/${entry.id}`,
      metadata: compactEntry(entry),
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  }));
}

function createRecallMcpServer() {
  const server = new McpServer({
    name: 'recall-mcp',
    version: pkg.version,
    websiteUrl: 'https://gitlab.com/jesseneff/recall-public',
  });
  registerRecallTools(server);
  return server;
}

function createRecallMcpExpressApp() {
  process.env.RECALL_MCP_TRANSPORT = 'streamable-http';
  process.env.RECALL_MCP_CLIENT = process.env.RECALL_MCP_CLIENT || 'chatgpt-desktop-mcp';
  const app = createMcpExpressApp({
    host: '127.0.0.1',
    allowedHosts: getAllowedHttpHosts(),
  });
  const transports = {};
  const authMode = getMcpAuthMode();
  let authMiddleware = null;

  if (authMode === 'oauth') {
    const publicMcpUrl = new URL(getPublicMcpUrl());
    const issuerUrl = new URL(publicMcpUrl.origin);
    const oauthProvider = new RecallOAuthProvider();
    app.use(mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl,
      baseUrl: issuerUrl,
      resourceServerUrl: publicMcpUrl,
      resourceName: 'Recall MCP',
      serviceDocumentationUrl: new URL('https://recallmeridian.com/'),
      scopesSupported: [OAUTH_SCOPE],
      clientRegistrationOptions: { rateLimit: false },
      authorizationOptions: { rateLimit: false },
      tokenOptions: { rateLimit: false },
      revocationOptions: { rateLimit: false },
    }));
    authMiddleware = requireBearerAuth({
      verifier: oauthProvider,
      requiredScopes: [OAUTH_SCOPE],
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(publicMcpUrl),
    });
  }

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      server: 'recall-mcp',
      endpoint: '/mcp',
      dataDir: getDataDir(),
      allowedHosts: getAllowedHttpHosts(),
      authMode,
    });
  });

  const mcpPostHandler = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    try {
      let transport;
      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            transports[newSessionId] = transport;
          },
        });
        transport.onclose = () => {
          const closedSessionId = transport.sessionId;
          if (closedSessionId) delete transports[closedSessionId];
        };
        const server = createRecallMcpServer();
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: no valid MCP session id or initialize request.',
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Recall MCP request failed:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  };

  const mcpGetHandler = (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  };

  const mcpDeleteHandler = (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  };

  if (authMiddleware) {
    app.post('/mcp', authMiddleware, mcpPostHandler);
    app.get('/mcp', authMiddleware, mcpGetHandler);
    app.delete('/mcp', authMiddleware, mcpDeleteHandler);
  } else {
    app.post('/mcp', mcpPostHandler);
    app.get('/mcp', mcpGetHandler);
    app.delete('/mcp', mcpDeleteHandler);
  }

  return app;
}

function startRecallMcpServer({ port = 3033, host = '127.0.0.1' } = {}) {
  const app = createRecallMcpExpressApp();
  return app.listen(port, host, (error) => {
    if (error) {
      console.error('Failed to start Recall MCP server:', error);
      process.exit(1);
    }
    console.error(`Recall ChatGPT MCP server listening at http://${host}:${port}/mcp`);
  });
}

module.exports = {
  createRecallMcpServer,
  createRecallMcpExpressApp,
  getAllowedHttpHosts,
  getMcpAuthMode,
  startRecallMcpServer,
};
