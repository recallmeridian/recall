# Recall Meridian

[![npm version](https://img.shields.io/npm/v/@recallmeridian/recall.svg)](https://www.npmjs.com/package/@recallmeridian/recall)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Site](https://img.shields.io/badge/site-recallmeridian.com-008080)](https://recallmeridian.com)

**Local memory layer for AI agents.** Works with Claude, ChatGPT, Cursor, Codex, and any MCP client.

Recall Meridian stores per-project knowledge, milestones, decisions, and handoffs in a local knowledge base so your AI agent can pick up where the last session left off — without paying for a chat-history product or trusting a vendor's memory feature.

---

## Two ways in

**1. Try the pattern (no install, 30 seconds).** Drop **[`RECALL-PATTERN.md`](./RECALL-PATTERN.md)** into Claude Code as your project's `CLAUDE.md`. You immediately get: cross-session project memory with a real schema, six typed relationship types (supersedes / contradicts / confirms / qualifies / deprecates / child_of), source citations, and a markdown vault Claude reads on every session. No servers, no SaaS, no installs.

A pattern is not a runtime. Schema enforcement, decay, signed provenance, audit, and search all rely on the engine. The pattern's job is to teach the discipline and produce a vault that imports cleanly when you upgrade.

**2. Install the engine (npm, full features).** Add typed-graph SQL queries, signed provenance, an automated holdout-gated self-improvement loop, a 17-module security stack, scheduled defenses (DLP, canaries, dream cycle, adversary engine, anchor snapshots), and multi-machine sync:

```bash
npm install -g @recallmeridian/recall
```

Validate the work you already did, then import it (zero data loss):

```bash
recall pattern-validate ./        # health score 0-100, finds drift
recall import-vault ./ --repair   # imports, auto-fixes recoverable issues
```

Same schema, both modes. Upgrade is additive — the pattern is real on its own, and the engine adds on top of work you already did. See **[`RECALL-PATTERN.md`](./RECALL-PATTERN.md)** for the full comparison table.

Initialize a project:

```bash
mkdir my-thing && cd my-thing
recall init my-thing
```

---

## First useful workflow

```bash
# Capture a decision so future-you doesn't re-litigate it
recall add my-thing decisions "switched to postgres" --because "row-level locking"

# List what you've captured
recall query my-thing "TABLE name FROM *"

# Get a project handoff (the magic moment)
recall my-thing
```

The last command prints a ~300-word brief any AI assistant can ingest: milestones, open TODOs, recent decisions, next step. Paste it into Claude, ChatGPT, Cursor — anywhere.

---

## What this project is

Recall Meridian is **not** a chat memory feature, not a notes app, not an IDE rule file, not a vector database.

### Core concepts

Three layers in one stack:

| Layer | Size | What |
|---|---|---|
| L1 — Pointer | ~50 tokens | A breadcrumb your AI can follow |
| L2 — Summary | ~3 KB | Project state in narrative form |
| L3 — Full JSON | On demand | Every entry, every relationship |

Most "memory" tools dump everything into context and hope for the best. Recall Meridian starts with a 50-token pointer, expands to a 3 KB summary when the agent asks, and only loads full JSON when you specifically need it.

---

## How it's different

| | Slash commands / chat memory | Recall Meridian |
|---|---|---|
| Storage | Vendor-bound | Local SQLite |
| Scope | One chat / one IDE | Cross-tool, cross-session |
| Audit | Opaque | Full history, exportable |
| Trust model | Whatever the model remembered | Draft vs trusted entries with promotion gates |
| Lock-in | High | Apache 2.0, your data on your disk |

---

## Slash commands

Twelve commands installed. Five most-used:

| Command | Purpose |
|---|---|
| `/recall` | Project handoff — milestones, TODOs, next step |
| `/recall-sync` | Pull latest session data into the dashboard |
| `/recall-kb` | Add/list/update KB entries by category |
| `/recall-milestone` | Mark milestone complete or queue next |
| `/recall-analyze` | Run AI analysis over recent sessions |

Full list: `recall --help`.

---

## Works with

- Claude Code (CLI + IDE)
- Claude.ai web (via MCP)
- ChatGPT (via MCP)
- Cursor (via MCP)
- Codex CLI
- Any MCP-compatible client

---

## Architecture

Hexagonal: a stable core of invariants, a contract layer features must declare against, and pluggable adapters. Every feature run passes through `draft → reviewed → trusted` with an append-only audit ledger.

Storage is local SQLite + FTS5 search under `~/.recall/`. No embeddings server required; optional semantic search via your own OpenAI key.

Full architecture map, file-by-file inventory, and "how to plug in a custom feature": [HEXAGONAL.md](HEXAGONAL.md).

---

## Docs

- [docs/setup/getting-started.md](docs/setup/getting-started.md) — first-run walkthrough
- [docs/setup/feature-registry.md](docs/setup/feature-registry.md) — feature lifecycle
- [AGENTS.md](AGENTS.md) — instructions for AI agents working in this repo
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute

---

## Status

Pre-1.0. The CLI works today. Desktop app and the Meridian publishing protocol are in development — [join the waitlist](https://recallmeridian.com/#waitlist).

Local-first by design. Your knowledge base never leaves your machine unless you publish to a Meridian server (opt-in, future).

### What this is not ready for

- **Multi-user shared memory.** Per-machine local KB only — no team server yet.
- **Production secrets vault.** Use a real secrets manager.
- **Autonomous publication.** Anything that escapes the local KB requires explicit promotion.
- **Replacement for source control.** It augments git history; it doesn't replace it.

---

## License

Apache 2.0. See [LICENSE](LICENSE).
