# Desktop Recall MCP Setup

Date: 2026-05-06
Status: permanent named-tunnel setup

## Purpose

Expose local Recall memory to desktop AI clients as a writable MCP server,
instead of relying on any read-only built-in Recall connector surface.

This server is local-first. It reads and writes the Recall data directory from
`MERIDIAN_DATA` / `MERIDIAN_DATA_DIR`, or falls back to `~/.meridian`.

## ChatGPT Desktop

ChatGPT uses the Streamable HTTP server. The permanent ChatGPT connector URL is:

```text
https://chatgpt-mcp.recallmeridian.com/mcp
```

This hostname is a Cloudflare named tunnel, not a quick tunnel. Do not use
temporary `trycloudflare.com` or random ngrok URLs as the connected state; those
are only acceptable for one-off diagnostics.

The local writable server runs from the local non-OneDrive checkout:

```powershell
cd $env:USERPROFILE\Desktop\recall-cli
$env:MERIDIAN_DATA = "$PWD\.recall\kb"
$env:RECALL_MCP_PORT = "3034"
npm run mcp:chatgpt
```

Local health check:

```powershell
Invoke-RestMethod http://127.0.0.1:3034/health
```

Permanent public health check:

```powershell
Invoke-RestMethod https://chatgpt-mcp.recallmeridian.com/health
```

The permanent stack is managed by a user Startup-folder launcher plus a
scheduled health/recovery task:

```powershell
Get-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Recall ChatGPT Writable MCP Stack.cmd"
Get-ScheduledTask -TaskName "Recall ChatGPT Writable MCP Health Check"
```

The Startup launcher runs `%USERPROFILE%\.recall\start-recall-chatgpt-writable-stack.ps1`.
The health task runs `%USERPROFILE%\.recall\check-chatgpt-writable-mcp.ps1`.
Both point at `%USERPROFILE%\Desktop\recall-cli\.recall\kb` by default.

## Permanent Tunnel

The permanent tunnel is:

```text
Name: recall-chatgpt-mcp
Hostname: chatgpt-mcp.recallmeridian.com
Local service: http://127.0.0.1:3034
Config: %USERPROFILE%\.cloudflared\recall-chatgpt-mcp.yml
```

Useful checks:

```powershell
cloudflared tunnel info recall-chatgpt-mcp
curl.exe -s --max-time 20 https://chatgpt-mcp.recallmeridian.com/health
```

### Connect In ChatGPT Desktop

1. Open ChatGPT desktop.
2. Go to Settings -> Apps & Connectors -> Advanced settings.
3. Enable developer mode if it is not already enabled.
4. Go to Settings -> Apps & Connectors -> Create.
5. Use:
   - Connector name: `Recall Local`
   - Description: `Search, fetch, and write local Recall project memory. Use draft status for unreviewed ChatGPT captures.`
   - Connector URL: `https://chatgpt-mcp.recallmeridian.com/mcp`
6. After creation, verify the advertised tools include:
   - `search`
   - `fetch`
   - `recall_status`
   - `recall_projects`
   - `recall_search`
   - `recall_browse`
   - `recall_get`
   - `recall_add_entry`
   - `recall_update_entry`
   - `recall_retire_entry`
   - `recall_mcp_diagnostics`

Write tools should trigger ChatGPT confirmation before the write is executed.

### ChatGPT Smoke Prompts

```text
Use Recall Local and run recall_mcp_diagnostics.
```

```text
Use Recall Local to search the research project for "ChatGPT MCP bridge".
```

```text
Use Recall Local to add this as a draft Recall entry in project research:
name: ChatGPT desktop Recall write path
category: integration
description: ChatGPT desktop should use the writable Recall MCP app, not only the read-only Recall fetch connector.
```

## Claude Desktop

Claude Desktop uses a local stdio MCP server. Configure it from the local
checkout:

```powershell
cd $env:USERPROFILE\Desktop\recall-cli
npm run mcp:configure-claude
```

The command backs up `%APPDATA%\Claude\claude_desktop_config.json`, then writes
this server entry:

```json
{
  "mcpServers": {
    "recall": {
      "type": "stdio",
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "%USERPROFILE%\\Desktop\\recall-cli\\bin\\recall-stdio-mcp.js"
      ],
      "cwd": "%USERPROFILE%\\Desktop\\recall-cli",
      "env": {
        "MERIDIAN_DATA": "%USERPROFILE%\\Desktop\\recall-cli\\.recall\\kb",
        "RECALL_MCP_CLIENT": "claude-desktop-mcp"
      }
    }
  }
}
```

After changing config, restart Claude Desktop or use Developer -> Reload MCP
Configuration if developer tools are enabled.

### Claude Smoke Prompts

```text
Use Recall and run recall_mcp_diagnostics.
```

```text
Use Recall to search project research for "ChatGPT MCP bridge".
```

```text
Use Recall to add this as a draft Recall entry in project research:
name: Claude desktop Recall write path
category: integration
description: Claude Desktop should use the local stdio Recall MCP server with the same writable tool surface as ChatGPT Desktop.
```

## Verification

Run the focused desktop MCP tests:

```powershell
npm test -- test/chatgpt-recall-mcp-server.test.js test/claude-desktop-config.test.js --runInBand
```

If the stdio test fails with `spawn EPERM` inside a sandbox, rerun it outside
the sandbox. Claude Desktop itself launches the stdio MCP process as a normal
desktop child process.

## Notes

- The built-in/app Recall connector may still expose only a read-only `_fetch`
  style tool. That is a different surface.
- This MCP server is the writable local Recall endpoint for desktop MCP
  clients.
- Keep the ChatGPT HTTP server bound to `127.0.0.1` for local development. Let
  the tunnel provide HTTPS rather than binding Recall directly to a public
  interface.
- Keep both clients pointed at `%USERPROFILE%\Desktop\recall-cli\.recall\kb`
  unless you intentionally migrate the active Recall data directory.
