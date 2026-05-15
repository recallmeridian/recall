#!/usr/bin/env node
'use strict';

const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { createRecallMcpServer } = require('../lib/chatgpt-recall-mcp-server');

async function main() {
  process.env.RECALL_MCP_TRANSPORT = 'stdio';
  process.env.RECALL_MCP_CLIENT = process.env.RECALL_MCP_CLIENT || 'claude-desktop-mcp';

  const server = createRecallMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Recall stdio MCP server failed:', error);
  process.exit(1);
});
