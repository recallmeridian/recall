'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { configureClaudeDesktopRecall } = require('../scripts/configure-claude-desktop-recall');

describe('Claude Desktop Recall MCP config', () => {
  let originalConfigPath;

  beforeEach(() => {
    originalConfigPath = process.env.CLAUDE_DESKTOP_CONFIG;
  });

  afterEach(() => {
    if (originalConfigPath === undefined) {
      delete process.env.CLAUDE_DESKTOP_CONFIG;
    } else {
      process.env.CLAUDE_DESKTOP_CONFIG = originalConfigPath;
    }
  });

  test('merges a local stdio Recall server and preserves other servers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-claude-config-'));
    const configPath = path.join(root, 'claude_desktop_config.json');
    process.env.CLAUDE_DESKTOP_CONFIG = configPath;
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        other: {
          command: 'other',
          args: [],
        },
      },
    }, null, 2));

    const repoRoot = path.join(root, 'recall-cli');
    fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });

    const result = configureClaudeDesktopRecall({ repoRoot, serverName: 'recall' });

    const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(updated.mcpServers.other.command).toBe('other');
    expect(updated.mcpServers.recall.type).toBe('stdio');
    expect(updated.mcpServers.recall.args[0]).toBe(path.join(repoRoot, 'bin', 'recall-stdio-mcp.js'));
    expect(updated.mcpServers.recall.env.MERIDIAN_DATA).toBe(path.join(repoRoot, '.recall', 'kb'));
    expect(result.backupPath).toBeTruthy();
    expect(fs.existsSync(result.backupPath)).toBe(true);
  });
});
