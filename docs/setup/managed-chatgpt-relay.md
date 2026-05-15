# Managed ChatGPT Relay

Date: 2026-05-06
Status: release architecture slice

## Purpose

ChatGPT custom MCP connectors require a public HTTPS endpoint. A local Recall
server on `localhost` is not enough, so a local-first open-source release needs
a managed bridge for normal users.

The paid service shape is:

```text
ChatGPT
  -> https://<workspace>.mcp.recallmeridian.com/mcp
  -> Recall Meridian relay
  -> authenticated outbound connection from the user's local Recall app
  -> local Recall MCP server
  -> local Recall data directory
```

## Product Boundary

- Open-source Recall: local engine, local MCP server, bring-your-own tunnel for
  technical users.
- Relay Pro: managed recallmeridian.com connector URL, device pairing, health
  recovery, and relay uptime.
- Team: managed relay plus multiple users/devices, workspace policy, and admin
  controls.

The relay must not become the database accidentally. Default retention is
metadata only. Raw memory remains local unless the user explicitly opts into
hosted sync/storage.

## Local Commands

```powershell
recall relay service-plan
recall relay configure --workspace my-workspace --device desktop-one
recall relay doctor
recall relay pairing-packet --json
recall relay agent-manifest --json
recall relay connector-url
```

`recall relay configure` writes `relay-config.json` under the active
`MERIDIAN_DATA` directory. It refuses temporary tunnel hosts such as
`trycloudflare.com`; those URLs are diagnostic only.

## Service Contract

The hosted relay service needs to consume:

- `relay-config.json`: local relay endpoint, public connector URL, token
  reference, and data policy.
- `pairing-packet`: workspace/device identity and capabilities for device
  registration.
- `agent-manifest`: reconnect policy and the allowed MCP tool proxy surface.

The local agent will eventually keep an outbound authenticated WebSocket or
HTTP/2 stream open to `relay.recallmeridian.com`. The hosted relay terminates
ChatGPT's Streamable HTTP MCP connection and proxies model tool calls over that
outbound local-agent channel.

## Release Rule

Do not document temporary tunnel URLs as a fix. A release-grade ChatGPT setup is
only connected when it has:

- stable HTTPS hostname under `recallmeridian.com`
- named relay identity
- device pairing/token lifecycle
- local MCP health check
- public MCP tool-list smoke test
- clear write/draft policy
