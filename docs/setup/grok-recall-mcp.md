# Grok / xAI Recall MCP Setup

Date: 2026-05-11
Status: permanent OAuth named-tunnel setup

## Purpose

Expose Recall project memory to Grok through xAI's Remote MCP / Custom MCP
connector path.

Grok uses remote MCP over an HTTPS URL and its web connector flow requires OAuth
discovery. It does not use the local stdio launcher that Claude Desktop uses.
For Recall, point Grok at the dedicated OAuth-protected endpoint:

```text
https://grok-mcp.recallmeridian.com/mcp
```

This is separate from the ChatGPT endpoint:

```text
https://chatgpt-mcp.recallmeridian.com/mcp
```

ChatGPT can continue using the existing endpoint. Grok uses the dedicated OAuth
endpoint so the two clients do not break each other.

## Local Server

The Grok MCP server runs locally on `127.0.0.1:3035` with OAuth enabled.

Start the permanent Grok stack from the local non-OneDrive checkout:

```powershell
cd $env:USERPROFILE\Desktop\recall-cli
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-grok-oauth-mcp-stack.ps1
```

Health checks:

```powershell
Invoke-RestMethod http://127.0.0.1:3035/health
Invoke-RestMethod https://grok-mcp.recallmeridian.com/health
Invoke-RestMethod https://grok-mcp.recallmeridian.com/.well-known/oauth-protected-resource/mcp
```

Recovery check:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-grok-oauth-mcp.ps1
```

The Windows Startup launcher is:

```text
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Recall Grok OAuth MCP Stack.cmd
```

## Permanent Tunnel

```text
Name: recall-grok-mcp
Hostname: grok-mcp.recallmeridian.com
Local service: http://127.0.0.1:3035
Config: %USERPROFILE%\.cloudflared\recall-grok-mcp.yml
```

## Connector Packet

Print the Grok connector packet:

```powershell
recall relay grok-connector --server-url https://grok-mcp.recallmeridian.com/mcp --json
```

The packet includes:

- the MCP server URL
- the `server_label`
- a read-only first-pass `allowed_tools` list
- xAI Responses API tool configuration
- smoke prompts

## Connect In Grok

1. Open `https://grok.com/connectors`.
2. Click **New Connector**.
3. Choose **Custom**.
4. Fill the OAuth/MCP fields:

```text
Client ID: recall-grok-mcp
Authorization endpoint: https://grok-mcp.recallmeridian.com/authorize
Token endpoint: https://grok-mcp.recallmeridian.com/token
MCP server URL: https://grok-mcp.recallmeridian.com/mcp
Scope: mcp:tools
```

5. If Grok asks only for the MCP server URL, paste:

```text
https://grok-mcp.recallmeridian.com/mcp
```

6. Let Grok complete the OAuth flow.
7. Save the connector.

## Recommended First Tool Allowlist

Start with read/diagnostic tools:

```text
recall_status
recall_projects
recall_search
recall_browse
recall_get
recall_query_as_of
recall_kb_timeline
recall_mcp_diagnostics
```

After read tools work, add write tools intentionally:

```text
recall_add_entry
recall_update_entry
recall_retire_entry
```

## xAI Responses API Example

```json
{
  "type": "mcp",
  "server_url": "https://grok-mcp.recallmeridian.com/mcp",
  "server_label": "recall",
  "server_description": "Local-first Recall project memory: search, fetch, handoff, and draft write tools.",
  "allowed_tools": [
    "recall_status",
    "recall_projects",
    "recall_search",
    "recall_browse",
    "recall_get",
    "recall_query_as_of",
    "recall_kb_timeline",
    "recall_mcp_diagnostics"
  ]
}
```

## Smoke Prompts

```text
Use Recall and run recall_mcp_diagnostics.
```

```text
Use Recall to list my Recall projects.
```

```text
Use Recall to search the research project for MCP.
```

## Notes

- Grok's web connector flow requires OAuth discovery; this endpoint advertises
  OAuth protected-resource and authorization-server metadata.
- Local stdio MCP is still for Claude Desktop, not Grok.
- Keep write tools disabled until diagnostics and read tools work.
- Keep the MCP server bound to `127.0.0.1`; let the tunnel provide HTTPS.
