# The Recall Pattern

> Drop this single file into Claude Code and you get a persistent, typed, citation-disciplined memory layer for your project in 30 seconds — **with no installs, no servers, no SaaS account, just files**.
>
> A pattern is not a runtime. The pattern teaches the discipline and produces a vault that imports cleanly when you upgrade. There is no schema enforcement, no decay, no signed provenance, no audit, and no search. Those live in the engine: `npm install -g @recallmeridian/recall`. Same schema, zero data loss on upgrade — re-import is one command (`recall import-vault ./`).
>
> This file IS the pattern. Reading it teaches Claude how to maintain a knowledge base across sessions.

---

## The 3-minute version

If you want the absolute smallest thing to copy and run, here it is. Skim the rest of the file later.

**Folder layout:**
```
my-project/
├── CLAUDE.md            ← this file
├── decisions/<id>.json
├── lessons/<id>.json
├── todos/<id>.json
├── relationships.jsonl
└── sources/             ← original docs you cite
```

**Entry shape (`<category>/<id>.json`):**
```json
{
  "id": "use-postgres-not-mysql",
  "name": "Use Postgres, not MySQL",
  "description": "JSON column support and partial indexes outweigh familiarity. See sources/db-discussion-2026-04.md.",
  "status": "active",
  "confidence": 0.85,
  "sources": ["sources/db-discussion-2026-04.md"],
  "tags": ["database"]
}
```

**Relationship shape (one JSON object per line in `relationships.jsonl`):**
```json
{"from": "use-postgres-not-mysql", "to": "use-mysql", "type": "supersedes"}
```

**Six valid relationship types — these are not optional, the engine will reject any others:**
`supersedes`, `contradicts`, `confirms`, `qualifies`, `deprecates`, `child_of`.

**Three rules that make the pattern actually work:**
1. Never delete an entry. Mark it `status: "retired"` and add a `supersedes` row pointing the new entry at the old one.
2. Every claim cites a source under `sources/`. No source = no entry.
3. Use only the six relationship types above. "Related" doesn't count.

That's the whole pattern. Everything below is detail and examples.

---

## Quick start (60 seconds)

1. Create a folder for your project (any name): `mkdir my-project && cd my-project`
2. Save this file as `CLAUDE.md` in that folder.
3. Open Claude Code in the folder. (If you're not using Claude Code, paste this whole file as your first message in any Claude chat.)
4. Try it:
   - "Log a decision: we're going with PostgreSQL because of the JSON column support."
   - "What past decisions touched our database choice?"
   - "Show me all open TODOs in this project."

Claude will create `decisions/`, `lessons/`, `todos/` directories with structured entries following the schema below. Every entry has an ID, a typed relationship to others, a provenance citation, and a supersedes chain. **Across sessions**, Claude reads this folder at session start and remembers everything you logged.

---

## What this pattern gives you (and what it doesn't)

| Feature | Pattern only (this file) | Real Recall Engine |
|---|---|---|
| Persistent memory across sessions | ✅ filesystem-backed; Claude rereads on each session | ✅ + SQLite typed-edge graph |
| Project scoping | ✅ per-folder | ✅ per-project, cross-project queries |
| Typed relationships (6 types) | ✅ recorded in relationships.jsonl | ✅ + indexed for graph queries |
| Supersedes / contradicts chains | ✅ followed by Claude | ✅ + automatic conflict surfacing |
| Cite sources / no orphan entries | ✅ enforced by Claude | ✅ + cryptographic signing of provenance |
| Anti-Goodhart holdout split | manual | ✅ automated promotion gate |
| Nightly consolidation (dream cycle) | manual | ✅ scheduled |
| Egress DLP — block secrets in outputs | none | ✅ 19 detectors + hash-chained ledger |
| Canary entries — detect KB exfil | none | ✅ HMAC-signed honeypots |
| Audit ingest — every action recorded | none | ✅ untrusted-by-default ledger |
| Adversary engine — weekly red-team | none | ✅ scheduled |
| Synthesis service — compound evidence | manual | ✅ 5 typed synthesis modes |
| Graph anchors — tamper-evident KB hash | none | ✅ HMAC-SHA256 signed |
| Multi-machine sync | none | ✅ |
| Hash-chained ledgers for everything | none | ✅ 10+ ledgers |

**The pattern is real but discipline-dependent.** Claude has to follow the rules every time. In practice you'll see drift — a few weeks in, descriptions get short, relationships go uncited, ids stop matching the kebab-case format. That's normal. The engine fixes drift by enforcing the schema in code. Until you install it, run `recall pattern-validate ./` (after a one-time `npm install -g @recallmeridian/recall`, or just eyeball your vault) to see how far you've drifted.

**You should upgrade to the engine when:**
- You catch yourself wanting to ask "which decisions contradict each other?" — that's a graph query
- A relationship file gets large enough that you can't tell which edges still resolve to existing entries
- You want a search that goes beyond "open the folder and grep"
- You need provenance you can prove later (the engine signs entries; the pattern asks Claude nicely)
- You hit confidence drift — every entry has the same number, because the field is being ignored
- You want scheduled defenses (DLP, dream-cycle reflection, anchor snapshots) running in the background
- You're working across machines and need sync

---

## The pattern, in full

### 1. Folder layout

When you start a project with this pattern, your folder will look like:

```
my-project/
├── CLAUDE.md                          ← this file
├── decisions/
│   ├── postgres-over-mysql.md         ← human-readable description
│   └── postgres-over-mysql.json       ← structured metadata sidecar
├── lessons/
│   └── always-pin-major-deps.md
├── features/
├── milestones/
├── todos/
├── plans/
├── relationships.jsonl                ← typed-edge log (one row per relation)
└── sources/                           ← original PDFs / transcripts / dumps (immutable)
```

**Two important rules:**
- Each entry has BOTH a `.md` (description, human-editable) AND a `.json` (structured metadata, machine-readable). They're kept in sync.
- `relationships.jsonl` is append-only — never edit old rows; add new rows that supersede.

### 2. Project scoping

Every project gets its own folder. **Don't mix projects.** Cross-project work goes in separate folders that link to each other via the `parent_project` field (see schema below).

For most users, a single project folder is enough. For multi-project setups (research + work + personal), use sibling folders.

### 3. Entry categories

Six core categories. Each lives in its own subdirectory. You can add custom categories — Claude will follow the same schema.

| Category | What goes here | Example |
|---|---|---|
| `decisions/` | Choices you made that you don't want to relitigate | "Going with PostgreSQL over MySQL" |
| `lessons/` | Things you learned, especially from mistakes | "Always pin major deps; minor and patch are fine" |
| `features/` | What you've built, what's planned | "User auth via Clerk — built, deployed 2026-04-12" |
| `milestones/` | Project-level checkpoints | "Beta launch 2026-06-01" |
| `todos/` | Open work | "Add rate limiting to /api/login" |
| `plans/` | Multi-step plans you'll execute | "Q3 roadmap: add team workspaces" |

You can also add: `handoffs/`, `imports/`, `canaries/`, anything project-specific. Claude will follow the schema.

### 4. Entry schema

Every entry has these fields (in the `.json` sidecar):

```json
{
  "id": "postgres-over-mysql",
  "project_id": "my-project",
  "category": "decisions",
  "name": "Use PostgreSQL not MySQL",
  "description": "JSON column support and partial indexes outweighed Mysql's slightly easier admin tooling. See sources/db-comparison-2026-04.md for the bench.",
  "status": "active",
  "confidence": 0.9,
  "createdAt": "2026-04-12T10:00:00Z",
  "updatedAt": "2026-04-12T10:00:00Z",
  "supersededBy": null,
  "sources": ["sources/db-comparison-2026-04.md"],
  "tags": ["database", "infrastructure"]
}
```

Required fields:
- `id` — kebab-case, unique within (project_id, category)
- `project_id` — the folder name
- `category` — the subdirectory name
- `name` — human-readable title (≤80 chars)
- `description` — see the `.md` for the full prose; this can be a summary
- `status` — one of: `active` | `retired` | `superseded` | `closed` | `disputed`
- `confidence` — 0..1, how sure you are
- `createdAt` / `updatedAt` — ISO 8601

Optional but strongly recommended:
- `supersededBy` — id of the entry that replaces this one (when status=superseded)
- `sources` — paths to immutable source files (PDFs, transcripts, screenshots) under `sources/`
- `tags` — flat tags for free-form search

### 5. Typed relationships (the 6 link types)

Relationships go in `relationships.jsonl`, one JSON object per line:

```json
{"from": "postgres-over-mysql", "to": "json-column-pattern", "type": "child_of", "createdAt": "2026-04-12T10:00:00Z"}
{"from": "always-pin-major-deps", "to": "axios-1.8-broke-us", "type": "qualifies", "createdAt": "2026-04-15T14:00:00Z"}
{"from": "postgres-v2-decision", "to": "postgres-over-mysql", "type": "supersedes", "createdAt": "2026-05-20T09:00:00Z"}
```

The six types — and **only** these:

| Type | Meaning |
|---|---|
| `supersedes` | The `from` entry replaces the `to` entry. The `to` entry should now have `status: superseded` and `supersededBy: <from>`. |
| `contradicts` | The `from` and `to` disagree. Both should now have `status: disputed` until resolved. |
| `confirms` | The `from` entry adds evidence to the `to` entry (same claim, second source). |
| `qualifies` | The `from` entry refines the `to` entry (special case, edge condition, when-not-applicable). |
| `deprecates` | The `from` entry recommends retiring the `to` entry. |
| `child_of` | The `from` entry is a more specific instance of the `to` entry (e.g. one decision under a broader rule). |

**Reject any other link type.** Untyped links rot the graph.

### 6. The supersedes discipline (most important)

When you change your mind, do NOT edit the old entry. Instead:

1. Create a NEW entry with a new id, status `active`.
2. Add a `supersedes` row to `relationships.jsonl` from the new id to the old id.
3. Update the OLD entry: `status` → `superseded`, `supersededBy` → new id.
4. Leave the old entry's description intact, but append a one-line note:
   `SUPERSEDED 2026-05-13: replaced by <new-id> because <reason>.`

This way, **history is preserved**. Anyone reading the old entry can follow the chain to the current state. Anyone asking "why did we change this" gets the reason.

The same applies to `contradicts`, `deprecates`, etc. — never delete or edit; supersede.

### 7. The provenance discipline (cite sources)

**No claim without a cite.** Every entry's `sources` array must point to at least one of:

- An immutable file under `sources/` (PDF, screenshot, transcript, paste)
- An external URL (only if you trust it long-term — prefer archive.org links)
- Another entry id (when the claim is derived from a prior entry)

If you can't cite a source, the entry is a HYPOTHESIS — set `status: disputed` and `confidence: ≤ 0.5`. Don't promote to `active` without evidence.

This is "Truth/Evidence/Promotion" doctrine. It's the rule that keeps the KB from rotting into hand-wavy gut feel.

### 8. Anti-Goodhart discipline (when you start refining specialists)

If you're using the pattern to build a specialist (a Claude-with-a-system-prompt that improves over time), split your eval cases into two sets:

- **Visible set** (70%) — the cases you iterate against. The proposer sees these.
- **Holdout set** (30%) — the cases ONLY the gate sees. The proposer NEVER sees these.

When you change the specialist's prompt and want to know "did this help?", you measure against BOTH sets. If visible improves by 10pp but holdout regresses by 20pp, **revert**. The holdout regression beats the visible improvement.

This is the discipline that makes the loop *self-correcting* rather than self-fooling. The pattern says: keep visible and holdout in two separate directories (`evals/visible/`, `evals/holdout/`). Claude must not read `evals/holdout/` when proposing changes.

The real Recall Engine automates this entirely (see `recall il eval-cycle`). The pattern alone requires manual discipline.

### 9. Sources directory

`sources/` holds the raw, immutable inputs. PDFs, screenshots, transcripts, paste-ins. **Never edit a file in `sources/` after adding it.** If a source is wrong or outdated, add a NEW source with a different filename and update entries to cite the new one.

This is what makes the KB auditable: anyone can re-derive your conclusions from the sources you cited.

### 10. Claude's behavior — what to expect

When you open Claude Code in a folder with this `CLAUDE.md`, Claude will:

- **On session start**: read `CLAUDE.md`, then scan `decisions/`, `lessons/`, etc. to load current state.
- **When you add knowledge**: create a new `.md` + `.json` pair following the schema. Cite a source.
- **When you ask a question**: search across all entries, cite the ones it draws on by id.
- **When you propose something that conflicts with an existing entry**: surface the conflict, ask which is correct, and either add a `supersedes` (if your new view is right) or a `contradicts` (if both are tenable until resolved).
- **When you ask Claude to summarize the project**: produce a markdown article that cites entries by id and links them via the typed relationships.

Claude will **refuse** to:
- Edit a `superseded` entry's description (you can append, never overwrite)
- Add a relationship with a type not in the 6-type vocabulary
- Add an entry without at least one `source`
- Delete an entry (use `deprecates` instead)

### 11. Upgrade path — when to install the real Engine

You should consider installing the full Recall Engine when:

- Your vault has 100+ entries and grep stops being fast enough → you want SQLite-indexed typed-graph queries
- You want to sync the vault across multiple machines → engine handles federation
- You're worried about leaking secrets in outputs to people / Claude.ai / Moltbook → engine ships egress DLP
- You're building a real specialist and need automated holdout-gated promotion → engine ships the IL closed loop
- You want a security stack (DLP, canaries, audit-ingest, governor) → engine ships 17 modules
- You want nightly dream consolidation, weekly adversary runs, weekly anchor snapshots → engine ships scheduled tasks
- You want to be able to verify "my KB on 2026-04-12 had this exact hash" later → engine ships HMAC-signed graph anchors

Install:

```bash
npm install -g @recallmeridian/recall
```

Then import your existing vault (preserves all entries + relationships):

```bash
recall import-vault ./
```

That's the upgrade. Same schema. Zero loss. Add typed-graph + security + automation on top of work you already did.

---

## What this pattern IS NOT

Be honest about what you're getting:

- **It's not a server.** No daemon, no sync, no cross-machine. If you want that, install the engine.
- **It's not a security boundary.** Nothing prevents Claude from leaking secrets if your sources contain them. The engine's DLP scanner does. The pattern alone doesn't.
- **It's not self-improving.** Claude follows the pattern but doesn't run a closed-loop self-evolution cycle on its own prompt or retrieval recipe. The engine does (with anti-Goodhart holdout discipline). The pattern alone doesn't.
- **It's not signed.** Anyone with write access to the folder can change anything. The engine's hash-chained ledgers + HMAC-signed graph anchors make tampering detectable. The pattern alone doesn't.

These are real differences. If you need them, install the engine. If you don't, the pattern is genuinely useful as-is.

---

## License

MIT. Use it, fork it, modify it, ship products on top of it.

If you build something cool with the pattern, send it back — file a PR against the [Recall Meridian repo](https://github.com/recallmeridian/recall) under `examples/`. We'll add it to the docs.

---

## Frequently asked

**Q: Why not just use Obsidian?**
A: You can — point Obsidian at the same folder. Obsidian gets you the rendering; the pattern gets you the discipline (typed relations, supersedes chains, provenance). They're complementary.

**Q: Why not just use ChatGPT memory?**
A: ChatGPT memory is opaque, non-portable, and per-account. The pattern lives in your filesystem, version-controllable with git, portable across machines and across LLMs (works with Claude, Gemini, GPT, etc.).

**Q: What if I want to use this without Claude Code?**
A: Paste the whole file as your first message in any Claude / GPT / Gemini chat. Then describe your project. The LLM will follow the pattern within that chat. Persistence dies when the chat ends — for cross-session persistence, you need either Claude Code (filesystem) or the real Recall Engine (SQLite + signing).

**Q: Is this just an Obsidian vault?**
A: Structurally similar, but the typed relationships + supersedes discipline + the engine upgrade path are the differences. Obsidian wikilinks are untyped. The pattern uses 6 typed relations specifically because they're the ones the real Recall engine indexes.

**Q: Will my vault break if I upgrade to the engine later?**
A: No. The engine's `import-vault` command reads exactly this schema. Your entries, your relationships, your sources — all preserved. The engine adds typed-graph queries, signing, security, and the IL loop ON TOP of what you already have.

**Q: How is this different from Karpathy's LLM Wiki gist?**
A: Karpathy's pattern is one layer (markdown wiki). This pattern is two layers (markdown vault → optional typed-graph engine upgrade). The pattern's relationship vocabulary is typed (6 specific kinds) where Karpathy's is freeform wikilinks. And the engine adds anti-Goodhart discipline, security primitives, and signed provenance that Karpathy's wiki has no notion of.

---

## Credits + further reading

This pattern was extracted from the [Recall Meridian engine](https://github.com/recallmeridian/recall). It draws on:

- Karpathy's LLM Wiki gist (April 2026) for the markdown-vault format
- Hexagonal architecture (Cockburn 2005) for the engine's port discipline
- McClelland-McNaughton-O'Reilly 1995 complementary learning systems for the engine's dream cycle
- The 2026-05-12 OpenClaw security brainstorm for the security stack

Pattern file version: 1.0 (2026-05-13)
Engine version compatibility: ≥ 0.24.0
