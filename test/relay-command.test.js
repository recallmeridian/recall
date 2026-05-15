'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Command } = require('commander');
const relay = require('../lib/relay');
const registerRelay = require('../lib/commands/relay');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recall-relay-command-'));
}

async function runRelay(args, opts = {}) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: (str) => process.stdout.write(str),
    writeErr: (str) => process.stderr.write(str),
  });
  registerRelay(program);

  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  const originalData = process.env.MERIDIAN_DATA;
  console.log = (value = '') => logs.push(String(value));
  console.error = (value = '') => errors.push(String(value));
  process.exitCode = undefined;
  if (opts.dataDir) process.env.MERIDIAN_DATA = opts.dataDir;

  try {
    await program.parseAsync(['node', 'test', ...args]);
    return {
      stdout: logs.join('\n'),
      stderr: errors.join('\n'),
      exitCode: process.exitCode || 0,
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExitCode;
    if (originalData === undefined) delete process.env.MERIDIAN_DATA;
    else process.env.MERIDIAN_DATA = originalData;
  }
}

describe('managed relay', () => {
  let dir;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('builds a permanent recallmeridian connector config', () => {
    const config = relay.buildRelayConfig({
      workspace: 'alpha-team',
      device: 'desktop-one',
      pairingToken: 'secret-pairing-token',
    });

    expect(config).toMatchObject({
      schemaVersion: relay.CONFIG_SCHEMA,
      mode: 'managed_relay',
      workspaceId: 'alpha-team',
      deviceId: 'desktop-one',
      connectorUrl: 'https://alpha-team.mcp.recallmeridian.com/mcp',
      relayAgentUrl: 'wss://relay.recallmeridian.com/v1/agent',
      status: 'pairing_material_staged',
    });
    expect(config.auth.tokenFingerprint).toHaveLength(16);
    expect(config.policy.relayStoresRawMemory).toBe(false);
  });

  test('rejects temporary tunnel connector URLs', () => {
    expect(() => relay.buildRelayConfig({
      workspace: 'alpha-team',
      connectorUrl: 'https://random.trycloudflare.com/mcp',
    })).toThrow(/temporary tunnel/);
  });

  test('configure writes config and prints connector URL', async () => {
    const dataDir = path.join(dir, 'data');
    const output = await runRelay([
      'relay',
      'configure',
      '--workspace',
      'alpha-team',
      '--device',
      'desktop-one',
      '--json',
    ], { dataDir });
    const parsed = JSON.parse(output.stdout);

    expect(output.exitCode).toBe(0);
    expect(parsed.config.connectorUrl).toBe('https://alpha-team.mcp.recallmeridian.com/mcp');
    expect(fs.existsSync(path.join(dataDir, 'relay-config.json'))).toBe(true);
  });

  test('doctor flags unpaired config without checking network', async () => {
    const dataDir = path.join(dir, 'data');
    await runRelay([
      'relay',
      'configure',
      '--workspace',
      'alpha-team',
      '--device',
      'desktop-one',
      '--json',
    ], { dataDir });

    const output = await runRelay([
      'relay',
      'doctor',
      '--no-check-local',
      '--json',
    ], { dataDir });
    const parsed = JSON.parse(output.stdout);

    expect(output.exitCode).toBe(0);
    expect(parsed.status).toBe('ready_with_warnings');
    expect(parsed.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'relay-token-not-staged' }),
    ]));
  });

  test('prints pairing packet and agent manifest contracts', async () => {
    const dataDir = path.join(dir, 'data');
    await runRelay([
      'relay',
      'configure',
      '--workspace',
      'alpha-team',
      '--device',
      'desktop-one',
      '--pairing-token',
      'secret-pairing-token',
      '--json',
    ], { dataDir });

    const packetOutput = await runRelay(['relay', 'pairing-packet', '--json'], { dataDir });
    const manifestOutput = await runRelay(['relay', 'agent-manifest', '--json'], { dataDir });
    const packet = JSON.parse(packetOutput.stdout);
    const manifest = JSON.parse(manifestOutput.stdout);

    expect(packet).toMatchObject({
      schemaVersion: relay.PAIRING_SCHEMA,
      status: 'ready_for_relay_service_exchange',
      workspaceId: 'alpha-team',
    });
    expect(manifest).toMatchObject({
      schemaVersion: relay.AGENT_MANIFEST_SCHEMA,
      localMcpUrl: relay.DEFAULT_LOCAL_MCP_URL,
    });
    expect(manifest.proxyPolicy.allowTools).toContain('recall_add_entry');
  });

  test('builds a Grok MCP connector packet from relay config', async () => {
    const dataDir = path.join(dir, 'data');
    await runRelay([
      'relay',
      'configure',
      '--workspace',
      'alpha-team',
      '--device',
      'desktop-one',
      '--json',
    ], { dataDir });

    const output = await runRelay(['relay', 'grok-connector', '--json'], { dataDir });
    const packet = JSON.parse(output.stdout);

    expect(output.exitCode).toBe(0);
    expect(packet).toMatchObject({
      schemaVersion: relay.GROK_CONNECTOR_SCHEMA,
      status: 'ready_to_connect',
      connector: {
        serverUrl: 'https://alpha-team.mcp.recallmeridian.com/mcp',
        serverLabel: 'recall',
        transport: 'streamable_http',
      },
      xaiResponsesApiTool: {
        type: 'mcp',
        server_url: 'https://alpha-team.mcp.recallmeridian.com/mcp',
        server_label: 'recall',
      },
    });
    expect(packet.xaiResponsesApiTool.allowed_tools).toContain('recall_mcp_diagnostics');
    expect(packet.xaiResponsesApiTool.allowed_tools).not.toContain('recall_add_entry');
  });

  test('Grok connector command can target an explicit server URL', async () => {
    const output = await runRelay([
      'relay',
      'grok-connector',
      '--server-url',
      'https://chatgpt-mcp.recallmeridian.com/mcp',
      '--server-label',
      'recall-prod',
      '--json',
    ]);
    const packet = JSON.parse(output.stdout);

    expect(output.exitCode).toBe(0);
    expect(packet.connector.serverUrl).toBe('https://chatgpt-mcp.recallmeridian.com/mcp');
    expect(packet.connector.serverLabel).toBe('recall-prod');
    expect(packet.grokWebSetup.url).toBe('https://grok.com/connectors');
  });

  test('service plan describes the paid managed relay model', async () => {
    const output = await runRelay(['relay', 'service-plan', '--json']);
    const plan = JSON.parse(output.stdout);

    expect(output.exitCode).toBe(0);
    expect(plan).toMatchObject({
      schemaVersion: relay.SERVICE_PLAN_SCHEMA,
      productShape: 'local_first_managed_relay',
    });
    expect(plan.nonGoals).toContain('Do not require every user to buy a domain.');
  });
});
