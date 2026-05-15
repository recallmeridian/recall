#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function getClaudeConfigPath() {
  if (process.env.CLAUDE_DESKTOP_CONFIG) return process.env.CLAUDE_DESKTOP_CONFIG;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function configureClaudeDesktopRecall({ repoRoot = process.cwd(), serverName = 'recall' } = {}) {
  const configPath = getClaudeConfigPath();
  const configDir = path.dirname(configPath);
  fs.mkdirSync(configDir, { recursive: true });

  const config = readJson(configPath);
  const backupPath = fs.existsSync(configPath)
    ? `${configPath}.bak-${timestamp()}`
    : null;
  if (backupPath) fs.copyFileSync(configPath, backupPath);

  const nodePath = process.execPath;
  const launcher = path.join(repoRoot, 'bin', 'recall-stdio-mcp.js');
  const dataDir = path.join(repoRoot, '.recall', 'kb');

  config.mcpServers = config.mcpServers || {};
  config.mcpServers[serverName] = {
    type: 'stdio',
    command: nodePath,
    args: [launcher],
    cwd: repoRoot,
    env: {
      MERIDIAN_DATA: dataDir,
      RECALL_MCP_CLIENT: 'claude-desktop-mcp',
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return {
    configPath,
    backupPath,
    serverName,
    command: nodePath,
    args: [launcher],
    cwd: repoRoot,
    dataDir,
  };
}

if (require.main === module) {
  const result = configureClaudeDesktopRecall();
  console.log(JSON.stringify(result, null, 2));
}

module.exports = {
  configureClaudeDesktopRecall,
  getClaudeConfigPath,
};
