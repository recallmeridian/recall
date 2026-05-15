'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const meridian = require('../lib/meridian-core');
const { createRecallMcpExpressApp } = require('../lib/chatgpt-recall-mcp-server');

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recall-chatgpt-mcp-'));
}

function seedRecall(dataDir) {
  const kb = meridian.init(dataDir);
  kb.createProject({ id: 'research', name: 'Research', description: 'Test project' });
  kb.addEntry('research', {
    name: 'ChatGPT MCP Bridge',
    description: 'Recall should be available to ChatGPT through a writable MCP server.',
    category: 'integration',
    status: 'active',
    practicalValue: 'high',
    confidence: {
      value: 0.7,
      lastVerified: new Date().toISOString(),
      decayDays: 30,
      exempt: false,
      verificationStatus: 'verified',
    },
    fusion: { fusedFrom: [], fusedAt: null, fusionDepth: 0 },
  });
  kb.addEntry('research', {
    name: 'Kelly fraction 0.50',
    description: 'Sensitive-domain bot used Kelly fraction 0.50 before the calibration audit.',
    category: 'parameter',
    status: 'active',
    _extensions: {
      temporal: {
        valid_from: '2026-03-01T00:00:00.000Z',
        valid_to: '2026-04-02T00:00:00.000Z',
        superseded_by: ['kelly-fraction-025'],
      },
    },
    practicalValue: 'high',
    confidence: {
      value: 0.7,
      lastVerified: new Date().toISOString(),
      decayDays: 30,
      exempt: false,
      verificationStatus: 'verified',
    },
    fusion: { fusedFrom: [], fusedAt: null, fusionDepth: 0 },
  });
  kb.addEntry('research', {
    name: 'Kelly fraction 0.25',
    description: 'Sensitive-domain bot used Kelly fraction 0.25 after the calibration audit.',
    category: 'parameter',
    status: 'active',
    _extensions: {
      temporal: {
        valid_from: '2026-04-02T00:00:00.000Z',
        supersedes: ['kelly-fraction-050'],
      },
    },
    practicalValue: 'high',
    confidence: {
      value: 0.7,
      lastVerified: new Date().toISOString(),
      decayDays: 30,
      exempt: false,
      verificationStatus: 'verified',
    },
    fusion: { fusedFrom: [], fusedAt: null, fusionDepth: 0 },
  });
  kb.close();
}

function requestJsonWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'GET',
      headers: { Host: host },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            body: JSON.parse(body),
          });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function requestRaw(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(parsed, { method, headers }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: responseBody,
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('ChatGPT Recall MCP server', () => {
  let originalMeridianData;
  let originalAuthMode;
  let originalPublicMcpUrl;
  let originalStaticClientId;
  let originalStaticRedirectUris;
  let httpServer;
  let baseUrl;

  beforeEach(async () => {
    originalMeridianData = process.env.MERIDIAN_DATA;
    originalAuthMode = process.env.RECALL_MCP_AUTH_MODE;
    originalPublicMcpUrl = process.env.RECALL_MCP_PUBLIC_URL;
    originalStaticClientId = process.env.RECALL_MCP_STATIC_CLIENT_ID;
    originalStaticRedirectUris = process.env.RECALL_MCP_STATIC_REDIRECT_URIS;
    delete process.env.RECALL_MCP_AUTH_MODE;
    delete process.env.RECALL_MCP_PUBLIC_URL;
    delete process.env.RECALL_MCP_STATIC_CLIENT_ID;
    delete process.env.RECALL_MCP_STATIC_REDIRECT_URIS;
    const dataDir = makeTempDataDir();
    process.env.MERIDIAN_DATA = dataDir;
    seedRecall(dataDir);

    const app = createRecallMcpExpressApp();
    await new Promise((resolve) => {
      httpServer = app.listen(0, '127.0.0.1', resolve);
    });
    const address = httpServer.address();
    baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);
  });

  afterEach(async () => {
    if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
    if (originalMeridianData === undefined) {
      delete process.env.MERIDIAN_DATA;
    } else {
      process.env.MERIDIAN_DATA = originalMeridianData;
    }
    if (originalAuthMode === undefined) {
      delete process.env.RECALL_MCP_AUTH_MODE;
    } else {
      process.env.RECALL_MCP_AUTH_MODE = originalAuthMode;
    }
    if (originalPublicMcpUrl === undefined) {
      delete process.env.RECALL_MCP_PUBLIC_URL;
    } else {
      process.env.RECALL_MCP_PUBLIC_URL = originalPublicMcpUrl;
    }
    if (originalStaticClientId === undefined) {
      delete process.env.RECALL_MCP_STATIC_CLIENT_ID;
    } else {
      process.env.RECALL_MCP_STATIC_CLIENT_ID = originalStaticClientId;
    }
    if (originalStaticRedirectUris === undefined) {
      delete process.env.RECALL_MCP_STATIC_REDIRECT_URIS;
    } else {
      process.env.RECALL_MCP_STATIC_REDIRECT_URIS = originalStaticRedirectUris;
    }
  });

  test('advertises read and write tools to MCP clients', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(baseUrl);
    await client.connect(transport);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);

    expect(names).toContain('search');
    expect(names).toContain('fetch');
    expect(names).toContain('recall_add_entry');
    expect(names).toContain('recall_update_entry');
    expect(names).toContain('recall_retire_entry');
    expect(names).toContain('recall_query_as_of');
    expect(names).toContain('recall_kb_timeline');

    await client.close();
  });

  test('can call diagnostics and add a draft entry', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(baseUrl);
    await client.connect(transport);

    const diagnostics = await client.callTool({
      name: 'recall_mcp_diagnostics',
      arguments: {},
    });
    expect(diagnostics.structuredContent.server).toBe('recall-mcp');

    const added = await client.callTool({
      name: 'recall_add_entry',
      arguments: {
        project_id: 'research',
        name: 'Writable Recall Tool',
        description: 'A draft entry created through the ChatGPT MCP server.',
        category: 'integration',
      },
    });

    expect(added.structuredContent.entry.id).toBe('writable-recall-tool');
    expect(added.structuredContent.entry.status).toBe('draft');

    await client.close();
  });

  test('answers as-of temporal memory queries and timelines', async () => {
    const client = new Client({ name: 'temporal-test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(baseUrl);
    await client.connect(transport);

    const march = await client.callTool({
      name: 'recall_query_as_of',
      arguments: {
        project_id: 'research',
        query: 'Kelly fraction',
        as_of: '2026-03-20T00:00:00.000Z',
      },
    });
    expect(march.structuredContent.entries.map((entry) => entry.id)).toEqual(['kelly-fraction-050']);

    const april = await client.callTool({
      name: 'recall_search',
      arguments: {
        project_id: 'research',
        query: 'Kelly fraction',
        as_of: '2026-04-02T00:00:00.000Z',
      },
    });
    expect(april.structuredContent.entries.map((entry) => entry.id)).toEqual(['kelly-fraction-025']);
    expect(april.structuredContent.temporalSummary.excluded).toBe(1);

    const timeline = await client.callTool({
      name: 'recall_kb_timeline',
      arguments: {
        project_id: 'research',
        entry_id: 'kelly-fraction-025',
      },
    });
    expect(timeline.structuredContent.versions.map((version) => version.entryId)).toEqual([
      'kelly-fraction-050',
      'kelly-fraction-025',
    ]);

    await client.close();
  });

  test('allows the permanent recallmeridian.com tunnel host header', async () => {
    const healthUrl = new URL('/health', baseUrl);
    for (const host of ['mcp.recallmeridian.com', 'chatgpt-mcp.recallmeridian.com']) {
      const result = await requestJsonWithHost(healthUrl, host);

      expect(result.statusCode).toBe(200);
      expect(result.body).toMatchObject({
        ok: true,
        server: 'recall-mcp',
        endpoint: '/mcp',
      });
      expect(result.body.allowedHosts).toContain(host);
    }
  });

  test('can expose an OAuth protected MCP surface for Grok style connectors', async () => {
    await new Promise((resolve) => httpServer.close(resolve));
    process.env.RECALL_MCP_AUTH_MODE = 'oauth';
    const app = createRecallMcpExpressApp();
    await new Promise((resolve) => {
      httpServer = app.listen(0, '127.0.0.1', resolve);
    });
    const address = httpServer.address();
    baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);
    process.env.RECALL_MCP_PUBLIC_URL = baseUrl.href;

    await new Promise((resolve) => httpServer.close(resolve));
    const oauthApp = createRecallMcpExpressApp();
    await new Promise((resolve) => {
      httpServer = oauthApp.listen(address.port, '127.0.0.1', resolve);
    });

    const metadataUrl = new URL('/.well-known/oauth-protected-resource/mcp', baseUrl);
    const metadata = await requestRaw(metadataUrl);
    expect(metadata.statusCode).toBe(200);
    const protectedResource = JSON.parse(metadata.body);
    expect(protectedResource.resource).toBe(baseUrl.href);
    expect(protectedResource.authorization_servers).toEqual([baseUrl.origin + '/']);

    const unauthenticated = await requestRaw(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers['www-authenticate']).toContain('resource_metadata=');

    const registration = await requestRaw(new URL('/register', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['http://127.0.0.1/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: 'Grok test connector',
      }),
    });
    expect(registration.statusCode).toBe(201);
    const client = JSON.parse(registration.body);
    expect(client.client_id).toBeTruthy();

    const verifier = 'test-code-verifier-for-grok-oauth-flow';
    const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
    const authorizeUrl = new URL('/authorize', baseUrl);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', client.client_id);
    authorizeUrl.searchParams.set('redirect_uri', 'http://127.0.0.1/callback');
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('scope', 'mcp:tools');
    authorizeUrl.searchParams.set('resource', baseUrl.href);
    const authorization = await requestRaw(authorizeUrl);
    expect(authorization.statusCode).toBe(302);
    const redirect = new URL(authorization.headers.location);
    expect(redirect.searchParams.get('code')).toBeTruthy();

    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: redirect.searchParams.get('code'),
      code_verifier: verifier,
      redirect_uri: 'http://127.0.0.1/callback',
      resource: baseUrl.href,
    }).toString();
    const tokenResponse = await requestRaw(new URL('/token', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });
    expect(tokenResponse.statusCode).toBe(200);
    const token = JSON.parse(tokenResponse.body);
    expect(token.access_token).toBeTruthy();
    expect(token.scope).toBe('mcp:tools');
  });

  test('oauth mode supports permanent Grok static client id', async () => {
    process.env.RECALL_MCP_AUTH_MODE = 'oauth';
    process.env.RECALL_MCP_STATIC_CLIENT_ID = 'recall-grok-mcp';
    process.env.RECALL_MCP_STATIC_REDIRECT_URIS = 'http://127.0.0.1/callback';
    const app = createRecallMcpExpressApp();
    await new Promise((resolve) => {
      httpServer = app.listen(0, '127.0.0.1', resolve);
    });
    const address = httpServer.address();
    baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);
    process.env.RECALL_MCP_PUBLIC_URL = baseUrl.href;

    await new Promise((resolve) => httpServer.close(resolve));
    const oauthApp = createRecallMcpExpressApp();
    await new Promise((resolve) => {
      httpServer = oauthApp.listen(address.port, '127.0.0.1', resolve);
    });

    const verifier = 'test-code-verifier-for-static-grok-client';
    const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
    const authorizeUrl = new URL('/authorize', baseUrl);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', 'recall-grok-mcp');
    authorizeUrl.searchParams.set('redirect_uri', 'http://127.0.0.1/callback');
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('scope', 'mcp:tools');
    authorizeUrl.searchParams.set('resource', baseUrl.href);
    const authorization = await requestRaw(authorizeUrl);
    expect(authorization.statusCode).toBe(302);
    const redirect = new URL(authorization.headers.location);
    expect(redirect.searchParams.get('code')).toBeTruthy();

    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'recall-grok-mcp',
      code: redirect.searchParams.get('code'),
      code_verifier: verifier,
      redirect_uri: 'http://127.0.0.1/callback',
      resource: baseUrl.href,
    }).toString();
    const tokenResponse = await requestRaw(new URL('/token', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });
    expect(tokenResponse.statusCode).toBe(200);
    const token = JSON.parse(tokenResponse.body);
    expect(token.access_token).toBeTruthy();
    expect(token.scope).toBe('mcp:tools');
  });

  test('stdio launcher works for Claude Desktop style clients', async () => {
    const client = new Client({ name: 'claude-smoke-client', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, '..', 'bin', 'recall-stdio-mcp.js')],
      env: {
        MERIDIAN_DATA: process.env.MERIDIAN_DATA,
        RECALL_MCP_CLIENT: 'claude-desktop-mcp',
      },
      cwd: path.join(__dirname, '..'),
      stderr: 'pipe',
    });

    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toContain('recall_mcp_diagnostics');
    expect(names).toContain('recall_add_entry');

    const diagnostics = await client.callTool({
      name: 'recall_mcp_diagnostics',
      arguments: {},
    });
    expect(diagnostics.structuredContent.transport).toBe('stdio');
    expect(diagnostics.structuredContent.clientSurface).toBe('claude-desktop-mcp');

    await client.close();
  });
});
