'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const cliConfig = require('./cli-config');

const CONFIG_SCHEMA = 'recall_managed_relay_config/v1';
const PAIRING_SCHEMA = 'recall_managed_relay_pairing_packet/v1';
const AGENT_MANIFEST_SCHEMA = 'recall_managed_relay_agent_manifest/v1';
const SERVICE_PLAN_SCHEMA = 'recall_managed_relay_service_plan/v1';
const GROK_CONNECTOR_SCHEMA = 'recall_grok_mcp_connector/v1';

const DEFAULT_RELAY_ORIGIN = 'https://relay.recallmeridian.com';
const DEFAULT_CONNECTOR_BASE_DOMAIN = 'mcp.recallmeridian.com';
const DEFAULT_LOCAL_MCP_URL = 'http://127.0.0.1:3034/mcp';
const DEFAULT_TOKEN_ENV = 'RECALL_RELAY_TOKEN';

const TEMPORARY_TUNNEL_HOSTS = [
  'trycloudflare.com',
  'ngrok.io',
  'ngrok-free.app',
  'loca.lt',
  'localhost.run',
];

function dataDir() {
  return cliConfig.getDataDir();
}

function defaultConfigPath() {
  return path.join(dataDir(), 'relay-config.json');
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function slug(value, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(text)) {
    throw new Error(`${label} must be a DNS-safe slug using lowercase letters, numbers, and hyphens.`);
  }
  return text;
}

function normalizeUrl(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} is required.`);
  let parsed;
  try {
    parsed = new URL(text);
  } catch (_) {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    throw new Error(`${label} must use http, https, ws, or wss.`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function relayAgentUrl(relayOrigin) {
  const parsed = new URL(relayOrigin);
  parsed.protocol = parsed.protocol === 'http:' ? 'ws:' : 'wss:';
  parsed.pathname = '/v1/agent';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function connectorUrlFor(workspaceId, baseDomain = DEFAULT_CONNECTOR_BASE_DOMAIN) {
  return `https://${workspaceId}.${baseDomain}/mcp`;
}

function classifyConnectorUrl(url) {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  const temporary = TEMPORARY_TUNNEL_HOSTS.find((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
  return {
    hostname,
    temporaryTunnel: Boolean(temporary),
    temporaryTunnelProvider: temporary || '',
    secure: parsed.protocol === 'https:',
    mcpPath: parsed.pathname === '/mcp',
    recallMeridianDomain: hostname === 'recallmeridian.com' || hostname.endsWith('.recallmeridian.com'),
  };
}

function tokenFingerprint(token) {
  if (!token) return '';
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
}

function buildRelayConfig(opts = {}) {
  const workspaceId = slug(opts.workspace || opts.workspaceId, 'workspace');
  const deviceId = slug(opts.device || opts.deviceId || os.hostname(), 'device');
  const relayOrigin = normalizeUrl(opts.relayOrigin || DEFAULT_RELAY_ORIGIN, 'relay origin');
  const connectorUrl = normalizeUrl(
    opts.connectorUrl || connectorUrlFor(workspaceId, opts.connectorBaseDomain || DEFAULT_CONNECTOR_BASE_DOMAIN),
    'connector URL'
  );
  const connector = classifyConnectorUrl(connectorUrl);
  if (connector.temporaryTunnel) {
    throw new Error(`Connector URL uses temporary tunnel host ${connector.hostname}; managed relay connectors must use a permanent domain.`);
  }
  if (!connector.secure) {
    throw new Error('Connector URL must use HTTPS for ChatGPT.');
  }
  if (!connector.mcpPath) {
    throw new Error('Connector URL must end with /mcp.');
  }
  const localMcpUrl = normalizeUrl(opts.localMcpUrl || DEFAULT_LOCAL_MCP_URL, 'local MCP URL');
  const localHealthUrl = opts.localHealthUrl
    ? normalizeUrl(opts.localHealthUrl, 'local health URL')
    : localMcpUrl.replace(/\/mcp$/, '/health');
  const pairingToken = opts.pairingToken || '';
  const tokenEnv = opts.tokenEnv || DEFAULT_TOKEN_ENV;
  return {
    schemaVersion: CONFIG_SCHEMA,
    mode: 'managed_relay',
    workspaceId,
    deviceId,
    connectorUrl,
    relayOrigin,
    relayAgentUrl: relayAgentUrl(relayOrigin),
    localMcpUrl,
    localHealthUrl,
    auth: {
      tokenRef: `env:${tokenEnv}`,
      tokenFingerprint: tokenFingerprint(pairingToken),
      pairedAt: '',
    },
    policy: {
      dataPlane: 'local_first_proxy',
      relayStoresRawMemory: false,
      relayRetention: 'metadata_only_by_default',
      quickTunnelsAllowed: false,
      writeConfirmation: 'chatgpt_confirmation_plus_local_policy',
    },
    status: pairingToken ? 'pairing_material_staged' : 'configured_unpaired',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function writeRelayConfig(config, opts = {}) {
  const outputPath = path.resolve(opts.configPath || defaultConfigPath());
  ensureDir(outputPath);
  fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return outputPath;
}

function readRelayConfig(opts = {}) {
  const configPath = path.resolve(opts.configPath || defaultConfigPath());
  if (!fs.existsSync(configPath)) {
    throw new Error(`Relay config not found at ${configPath}. Run recall relay configure first.`);
  }
  return {
    configPath,
    config: JSON.parse(fs.readFileSync(configPath, 'utf8')),
  };
}

function buildPairingPacket(configInput, opts = {}) {
  const config = configInput.config || configInput;
  return {
    schemaVersion: PAIRING_SCHEMA,
    generatedAt: new Date().toISOString(),
    workspaceId: config.workspaceId,
    deviceId: config.deviceId,
    connectorUrl: config.connectorUrl,
    relayAgentUrl: config.relayAgentUrl,
    localCapabilities: [
      'mcp.streamable_http.proxy',
      'recall.search',
      'recall.fetch',
      'recall.write_draft',
      'recall.update_entry',
      'recall.retire_entry',
    ],
    auth: {
      tokenRef: config.auth && config.auth.tokenRef,
      tokenFingerprint: config.auth && config.auth.tokenFingerprint,
      pairingCode: opts.pairingCode || '',
    },
    dataPolicy: config.policy,
    status: 'ready_for_relay_service_exchange',
    nextAction: 'Register this device with the Recall Meridian relay service, then store the issued token in the configured environment variable.',
  };
}

function buildAgentManifest(configInput) {
  const config = configInput.config || configInput;
  return {
    schemaVersion: AGENT_MANIFEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    workspaceId: config.workspaceId,
    deviceId: config.deviceId,
    relayAgentUrl: config.relayAgentUrl,
    localMcpUrl: config.localMcpUrl,
    localHealthUrl: config.localHealthUrl,
    reconnectPolicy: {
      initialDelayMs: 1000,
      maxDelayMs: 30000,
      jitter: true,
      heartbeatSeconds: 30,
    },
    proxyPolicy: {
      allowTools: [
        'search',
        'fetch',
        'recall_status',
        'recall_projects',
        'recall_search',
        'recall_browse',
        'recall_get',
        'recall_add_entry',
        'recall_update_entry',
        'recall_retire_entry',
        'recall_mcp_diagnostics',
      ],
      denyRawDatabaseAccess: true,
      draftWritesDefault: true,
      requireLocalDataDir: true,
    },
  };
}

function buildGrokConnectorPacket(configInput, opts = {}) {
  const config = configInput && (configInput.config || configInput);
  const serverUrl = normalizeUrl(
    opts.serverUrl || (config && config.connectorUrl) || 'https://chatgpt-mcp.recallmeridian.com/mcp',
    'Grok MCP server URL'
  );
  const connector = classifyConnectorUrl(serverUrl);
  const serverLabel = opts.serverLabel || 'recall';
  const serverDescription = opts.serverDescription || 'Local-first Recall project memory: search, fetch, handoff, and draft write tools.';
  const allowedTools = opts.allowedTools || [
    'recall_status',
    'recall_projects',
    'recall_search',
    'recall_browse',
    'recall_get',
    'recall_query_as_of',
    'recall_kb_timeline',
    'recall_mcp_diagnostics',
  ];
  const writeTools = [
    'recall_add_entry',
    'recall_update_entry',
    'recall_retire_entry',
  ];

  return {
    schemaVersion: GROK_CONNECTOR_SCHEMA,
    generatedAt: new Date().toISOString(),
    product: 'Recall for Grok',
    status: connector.secure && connector.mcpPath ? 'ready_to_connect' : 'needs_endpoint_fix',
    connector: {
      name: opts.name || 'Recall Local',
      serverUrl,
      serverLabel,
      serverDescription,
      transport: 'streamable_http',
      xaiSupportedTransports: ['streamable_http', 'sse'],
      secure: connector.secure,
      mcpPath: connector.mcpPath,
      temporaryTunnel: connector.temporaryTunnel,
    },
    grokWebSetup: {
      url: 'https://grok.com/connectors',
      steps: [
        'Open grok.com/connectors.',
        'Click New Connector.',
        'Choose Custom.',
        `Paste the MCP server URL: ${serverUrl}`,
        'Complete any authentication fields required by your deployment.',
        'Verify Grok can run recall_mcp_diagnostics.',
      ],
    },
    xaiResponsesApiTool: {
      type: 'mcp',
      server_url: serverUrl,
      server_label: serverLabel,
      server_description: serverDescription,
      allowed_tools: allowedTools,
    },
    recommendedAllowedTools: allowedTools,
    optionalWriteTools: writeTools,
    smokePrompts: [
      'Use Recall and run recall_mcp_diagnostics.',
      'Use Recall to list my Recall projects.',
      'Use Recall to search the research project for MCP.',
    ],
    cautions: [
      'Grok/xAI Remote MCP requires an HTTPS Streamable HTTP or SSE endpoint; local stdio MCP is not enough.',
      'Keep write tools out of allowed_tools for the first Grok smoke test; add them only after diagnostics and read tools work.',
      'If using a local Recall server, expose it through a stable HTTPS tunnel or managed relay.',
    ],
  };
}

function probeJson(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      resolve({ ok: false, url, error: err.message });
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(parsed, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let json = null;
        let parseError = '';
        try {
          json = body ? JSON.parse(body) : null;
        } catch (err) {
          parseError = err.message;
        }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300 && (!json || json.ok !== false),
          url,
          statusCode: res.statusCode,
          json,
          parseError,
        });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => {
      resolve({ ok: false, url, error: err.message });
    });
  });
}

async function buildRelayDoctor(opts = {}) {
  let loaded = null;
  const findings = [];
  try {
    loaded = readRelayConfig(opts);
  } catch (err) {
    findings.push({
      severity: 'blocker',
      id: 'relay-config-missing',
      title: 'Managed relay config is missing',
      detail: err.message,
      remediation: 'Run recall relay configure --workspace <slug> --device <slug>.',
    });
  }

  const config = loaded && loaded.config;
  if (config) {
    const connector = classifyConnectorUrl(config.connectorUrl);
    if (connector.temporaryTunnel) {
      findings.push({
        severity: 'blocker',
        id: 'temporary-tunnel-url',
        title: 'Connector URL uses a temporary tunnel',
        detail: config.connectorUrl,
        remediation: 'Use a permanent recallmeridian.com managed relay hostname.',
      });
    }
    if (!connector.recallMeridianDomain && opts.requireManagedDomain !== false) {
      findings.push({
        severity: 'warn',
        id: 'non-managed-domain',
        title: 'Connector URL is not under recallmeridian.com',
        detail: config.connectorUrl,
        remediation: 'Use the paid managed relay domain for mainstream ChatGPT setup.',
      });
    }
    if (!config.auth || !config.auth.tokenFingerprint) {
      findings.push({
        severity: 'warn',
        id: 'relay-token-not-staged',
        title: 'Relay token has not been staged',
        detail: config.auth ? config.auth.tokenRef : '',
        remediation: 'Complete relay pairing and store the issued token in the configured environment variable.',
      });
    }
  }

  const checks = {};
  if (config && opts.checkLocal !== false) {
    checks.localHealth = await probeJson(config.localHealthUrl, opts.timeoutMs);
    if (!checks.localHealth.ok) {
      findings.push({
        severity: 'blocker',
        id: 'local-mcp-health-failed',
        title: 'Local Recall MCP health check failed',
        detail: checks.localHealth.error || `status ${checks.localHealth.statusCode}`,
        remediation: 'Start the local Recall MCP server before connecting ChatGPT through the relay.',
      });
    }
  }
  if (config && opts.checkPublic) {
    const publicHealthUrl = config.connectorUrl.replace(/\/mcp$/, '/health');
    checks.publicHealth = await probeJson(publicHealthUrl, opts.timeoutMs);
    if (!checks.publicHealth.ok) {
      findings.push({
        severity: 'blocker',
        id: 'public-relay-health-failed',
        title: 'Public managed relay health check failed',
        detail: checks.publicHealth.error || `status ${checks.publicHealth.statusCode}`,
        remediation: 'Verify DNS, TLS, relay routing, and the local relay agent.',
      });
    }
  }

  const blockerCount = findings.filter((finding) => finding.severity === 'blocker').length;
  return {
    schemaVersion: 'recall_managed_relay_doctor/v1',
    generatedAt: new Date().toISOString(),
    status: blockerCount ? 'blocked' : findings.length ? 'ready_with_warnings' : 'ready',
    configPath: loaded ? loaded.configPath : path.resolve(opts.configPath || defaultConfigPath()),
    config: config || null,
    checks,
    findings,
    nextAction: blockerCount
      ? 'Fix blockers before adding the ChatGPT connector.'
      : config
        ? `Use ${config.connectorUrl} as the ChatGPT custom MCP connector URL.`
        : 'Run recall relay configure.',
  };
}

function buildServicePlan() {
  return {
    schemaVersion: SERVICE_PLAN_SCHEMA,
    generatedAt: new Date().toISOString(),
    productShape: 'local_first_managed_relay',
    publicConnectorRequirement: 'ChatGPT custom MCP connectors require a public HTTPS Streamable HTTP or SSE endpoint.',
    managedRelay: {
      domainPattern: 'https://<workspace>.mcp.recallmeridian.com/mcp',
      agentConnection: 'local Recall opens an outbound authenticated tunnel to relay.recallmeridian.com',
      dataPlane: 'proxy MCP calls to the user local Recall MCP server',
      defaultRetention: 'relay metadata only; raw memory remains local unless user opts into cloud storage',
      billingBasis: ['relay uptime', 'connector management', 'device pairing', 'workspace/team controls'],
    },
    tiers: [
      {
        id: 'open-source',
        promise: 'Local Recall engine and local MCP server; bring your own tunnel/domain.',
      },
      {
        id: 'relay-pro',
        promise: 'Managed recallmeridian.com HTTPS connector, local-first data, one user workspace.',
      },
      {
        id: 'team',
        promise: 'Managed relay plus multiple users/devices, admin controls, shared project policy.',
      },
    ],
    nonGoals: [
      'Do not require every user to buy a domain.',
      'Do not turn the relay into the database by accident.',
      'Do not treat temporary quick tunnels as production connectivity.',
    ],
  };
}

module.exports = {
  CONFIG_SCHEMA,
  PAIRING_SCHEMA,
  AGENT_MANIFEST_SCHEMA,
  GROK_CONNECTOR_SCHEMA,
  SERVICE_PLAN_SCHEMA,
  DEFAULT_RELAY_ORIGIN,
  DEFAULT_CONNECTOR_BASE_DOMAIN,
  DEFAULT_LOCAL_MCP_URL,
  buildAgentManifest,
  buildGrokConnectorPacket,
  buildPairingPacket,
  buildRelayConfig,
  buildRelayDoctor,
  buildServicePlan,
  classifyConnectorUrl,
  defaultConfigPath,
  readRelayConfig,
  writeRelayConfig,
};
