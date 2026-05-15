#!/usr/bin/env node
'use strict';

const { startRecallMcpServer } = require('../lib/chatgpt-recall-mcp-server');

const port = process.env.RECALL_MCP_PORT ? Number(process.env.RECALL_MCP_PORT) : 3033;
const host = process.env.RECALL_MCP_HOST || '127.0.0.1';

startRecallMcpServer({ port, host });
