'use strict';

const chalk = require('chalk');
const relay = require('../relay');

function printFindings(findings = []) {
  if (!findings.length) {
    console.log(chalk.green('No relay findings.'));
    return;
  }
  for (const finding of findings) {
    const color = finding.severity === 'blocker' ? chalk.red : chalk.yellow;
    console.log(color(`${finding.severity}: ${finding.id}`));
    console.log(`  ${finding.title}`);
    if (finding.detail) console.log(chalk.gray(`  ${finding.detail}`));
    if (finding.remediation) console.log(chalk.gray(`  ${finding.remediation}`));
  }
}

module.exports = function(program) {
  const command = program
    .command('relay')
    .description('Configure the managed recallmeridian.com relay for ChatGPT MCP access');

  command
    .command('grok-connector')
    .description('Print the Grok/xAI custom MCP connector packet for Recall')
    .option('--config-path <path>', 'Config path; defaults to MERIDIAN_DATA/relay-config.json')
    .option('--server-url <url>', 'Explicit HTTPS Recall MCP URL ending in /mcp')
    .option('--server-label <label>', 'Grok/xAI MCP server label', 'recall')
    .option('--include-write-tools', 'Include Recall write tools in allowed_tools')
    .option('--json', 'Print JSON')
    .action((opts) => {
      try {
        let config = null;
        try {
          config = relay.readRelayConfig(opts).config;
        } catch (_) {
          config = null;
        }
        const allowedTools = opts.includeWriteTools
          ? undefined
          : [
            'recall_status',
            'recall_projects',
            'recall_search',
            'recall_browse',
            'recall_get',
            'recall_query_as_of',
            'recall_kb_timeline',
            'recall_mcp_diagnostics',
          ];
        const packet = relay.buildGrokConnectorPacket(config || {}, {
          serverUrl: opts.serverUrl,
          serverLabel: opts.serverLabel,
          allowedTools,
        });
        if (opts.json) {
          console.log(JSON.stringify(packet, null, 2));
          return;
        }
        console.log(chalk.bold('\nRecall Grok MCP Connector\n'));
        console.log(`URL:   ${chalk.cyan(packet.connector.serverUrl)}`);
        console.log(`Label: ${packet.connector.serverLabel}`);
        console.log(`Tools: ${packet.recommendedAllowedTools.join(', ')}`);
        console.log('');
        console.log('Grok setup: grok.com/connectors -> New Connector -> Custom -> paste the URL above.');
        console.log('Smoke test: "Use Recall and run recall_mcp_diagnostics."');
        console.log('');
      } catch (err) {
        if (opts.json) console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
        else console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('service-plan')
    .description('Describe the local-first paid relay service architecture')
    .option('--json', 'Print JSON')
    .action((opts) => {
      const plan = relay.buildServicePlan();
      if (opts.json) {
        console.log(JSON.stringify(plan, null, 2));
        return;
      }
      console.log(chalk.bold('\nRecall Managed Relay Service\n'));
      console.log(`Shape: ${chalk.cyan(plan.productShape)}`);
      console.log(`URL:   ${plan.managedRelay.domainPattern}`);
      console.log(`Data:  ${plan.managedRelay.defaultRetention}`);
      console.log('');
    });

  command
    .command('configure')
    .description('Create local managed-relay config for this workspace/device')
    .requiredOption('--workspace <slug>', 'Workspace slug for <workspace>.mcp.recallmeridian.com')
    .option('--device <slug>', 'Device slug; defaults to the machine hostname')
    .option('--relay-origin <url>', 'Relay service origin', relay.DEFAULT_RELAY_ORIGIN)
    .option('--connector-base-domain <domain>', 'Base domain for generated connector URLs', relay.DEFAULT_CONNECTOR_BASE_DOMAIN)
    .option('--connector-url <url>', 'Explicit permanent ChatGPT connector URL ending in /mcp')
    .option('--local-mcp-url <url>', 'Local Recall MCP URL', relay.DEFAULT_LOCAL_MCP_URL)
    .option('--local-health-url <url>', 'Local Recall MCP health URL')
    .option('--token-env <name>', 'Environment variable that will hold the relay token')
    .option('--pairing-token <token>', 'Optional one-time token; only a fingerprint is stored')
    .option('--config-path <path>', 'Config path; defaults to MERIDIAN_DATA/relay-config.json')
    .option('--json', 'Print JSON')
    .action((opts) => {
      try {
        const config = relay.buildRelayConfig(opts);
        const configPath = relay.writeRelayConfig(config, opts);
        const result = { configPath, config };
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.green(`Relay config written: ${configPath}`));
        console.log(`Connector URL: ${chalk.cyan(config.connectorUrl)}`);
      } catch (err) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
        } else {
          console.error(chalk.red(`Error: ${err.message}`));
        }
        process.exitCode = 1;
      }
    });

  command
    .command('doctor')
    .description('Check whether local Recall is ready for the managed ChatGPT relay')
    .option('--config-path <path>', 'Config path; defaults to MERIDIAN_DATA/relay-config.json')
    .option('--no-check-local', 'Skip local MCP health check')
    .option('--check-public', 'Also check the public connector /health endpoint')
    .option('--no-require-managed-domain', 'Allow non-recallmeridian.com connector domains without warning')
    .option('--timeout-ms <ms>', 'Health check timeout in milliseconds', '4000')
    .option('--json', 'Print JSON')
    .action(async (opts) => {
      const report = await relay.buildRelayDoctor({
        ...opts,
        timeoutMs: Number(opts.timeoutMs || 4000),
      });
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        if (report.status === 'blocked') process.exitCode = 1;
        return;
      }
      console.log(chalk.bold('\nRecall Relay Doctor\n'));
      console.log(`Status: ${report.status === 'ready' ? chalk.green(report.status) : chalk.yellow(report.status)}`);
      console.log(`Config: ${chalk.cyan(report.configPath)}`);
      if (report.config) console.log(`URL:    ${chalk.cyan(report.config.connectorUrl)}`);
      console.log('');
      printFindings(report.findings);
      console.log('');
      if (report.status === 'blocked') process.exitCode = 1;
    });

  command
    .command('status')
    .description('Show the current managed-relay config')
    .option('--config-path <path>', 'Config path; defaults to MERIDIAN_DATA/relay-config.json')
    .option('--json', 'Print JSON')
    .action((opts) => {
      try {
        const result = relay.readRelayConfig(opts);
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(chalk.bold('\nRecall Relay Status\n'));
        console.log(`Workspace: ${chalk.cyan(result.config.workspaceId)}`);
        console.log(`Device:    ${chalk.cyan(result.config.deviceId)}`);
        console.log(`Connector: ${chalk.cyan(result.config.connectorUrl)}`);
        console.log(`Status:    ${result.config.status}`);
        console.log('');
      } catch (err) {
        if (opts.json) console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
        else console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('connector-url')
    .description('Print the ChatGPT custom MCP connector URL')
    .option('--config-path <path>', 'Config path; defaults to MERIDIAN_DATA/relay-config.json')
    .option('--json', 'Print JSON')
    .action((opts) => {
      try {
        const { config } = relay.readRelayConfig(opts);
        if (opts.json) {
          console.log(JSON.stringify({ connectorUrl: config.connectorUrl }, null, 2));
          return;
        }
        console.log(config.connectorUrl);
      } catch (err) {
        if (opts.json) console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
        else console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('pairing-packet')
    .description('Print the local device pairing packet for the managed relay service')
    .option('--config-path <path>', 'Config path; defaults to MERIDIAN_DATA/relay-config.json')
    .option('--pairing-code <code>', 'Optional user-visible pairing code from the service')
    .option('--json', 'Print JSON')
    .action((opts) => {
      try {
        const { config } = relay.readRelayConfig(opts);
        const packet = relay.buildPairingPacket(config, opts);
        console.log(JSON.stringify(packet, null, 2));
      } catch (err) {
        if (opts.json) console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
        else console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });

  command
    .command('agent-manifest')
    .description('Print the local relay-agent manifest consumed by the hosted relay service')
    .option('--config-path <path>', 'Config path; defaults to MERIDIAN_DATA/relay-config.json')
    .option('--json', 'Print JSON')
    .action((opts) => {
      try {
        const { config } = relay.readRelayConfig(opts);
        const manifest = relay.buildAgentManifest(config);
        console.log(JSON.stringify(manifest, null, 2));
      } catch (err) {
        if (opts.json) console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
        else console.error(chalk.red(`Error: ${err.message}`));
        process.exitCode = 1;
      }
    });
};
