# @meridian/core — Breaking Changes

## 0.2.0 — MIF v4.0 schema + Phase 0.5 engine harvest from Recall (2026-04-25)

### Schema changes (BREAKING)

The MIF schema is restructured into clean sub-objects. v3.0 entries are no
longer accepted by `KBStore.addEntry()` / `KBStore.updateEntry()`.

| v3.0 | v4.0 |
|---|---|
| `confidence` (number, optional) | `confidence.value` (number, 0-1) |
| (none) | `confidence.lastVerified`, `confidence.decayDays`, `confidence.exempt`, `confidence.verificationStatus` |
| (none) | `fusion.fusedFrom`, `fusion.fusedAt`, `fusion.fusionDepth` (capped at 5) |
| (none) | `practicalValue` enum (`high|medium|low|unrated`) |
| `additionalProperties: true` | `additionalProperties: false` — unknown fields rejected; use `_extensions` |
| `schemaVersion: pattern ^\d+\.\d+$` | `schemaVersion: const "4.0"` |

`disease_area`, `genes`, `pathways` remain top-level optional fields
(author-asserted biotech vocab, like `authors`/`tags`).

### Hub-local usage telemetry — NEW

Per the Q2 design override doctrine in this codebase
(`qualityscore-belongs-hub-local-not-in-signed-payload`), fields the hub
computes / applies policy to must NOT live in the signed entry payload.
Different hubs see different interaction histories; different rerankers
compute `responseStrength` differently. Forcing them into the signed
payload triggers a forced KB re-sign on every reranker tweak — a trap this
override was created specifically to avoid.

**Result:** `lastShownAt`, `lastUsedAt`, `responseStrength` are NOT in the
MIF v4.0 entry schema. They live in a separate `entry_usage` SQLite table
maintained by `KBStore`.

New KBStore methods:
- `recordShown(projectId, id, at?)` — tracks the retrieval-quality signal
- `recordUsed(projectId, id, responseStrength, at?)` — tracks the entry-quality signal
- `getUsage(projectId, id) → { lastShownAt, lastUsedAt, responseStrength, updatedAt } | null`

`HybridSearchEngine.hydrate()` LEFT-JOINs `entry_usage` at query time so
the reranker sees flat columns (`response_strength`, `last_used_at`,
`last_shown_at`). Entries with no usage row → NULL → reranker treats as
neutral (1.0 multiplier; no penalty for unmeasured entries).

### Migration path

For any existing v3.0 KB:

```bash
node packages/core/scripts/migrate-v3-to-v4.js --data-dir <path-to-data-dir>
node packages/core/scripts/migrate-v3-to-v4.js --data-dir <path> --dry-run  # preview
```

The script:
- Adds `confidence` sub-object: `value: 0.5` (neutral default), `lastVerified` = `addedAt`, `decayDays: 180`, `exempt: false`, `verificationStatus: 'unverified'`
- Builds `fusion` sub-object from v3 flat fields (`fused_from`, `fused_at`, `fusion_depth`)
- Buckets free-text `practical_value` into the v4 enum (handles `essential` → `high`, `useful` → `medium`, etc.)
- Preserves biotech vocab (`disease_area`, `genes`, `pathways`) as top-level
- Moves unknown v3 fields into `_extensions` (does NOT drop them)
- Idempotent — running twice is safe (second pass = no-op)
- **Does NOT add a `usage` field** — usage is hub-local. Migrated KBs start
  with an empty `entry_usage` table; usage accrues as the hub runs.

### New features in @meridian/core 0.2.0

- **MIF v4.0 schema** with `confidence` / `fusion` sub-objects, `practicalValue`
  enum, `_extensions` escape hatch, strict `additionalProperties: false`.
- **Hub-local `entry_usage` table** — per the Q2 design override.
- **Reranker upgrade** (`lib/reranker.js`):
  - New multiplicative factor `clampResponseStrength(rs)` — floor 0.05
    (Boisseau 2016 recovery), 1.0 ceiling, 1.0 neutral default.
  - New multiplicative factor `usedRecency(entry, nowMs)` — exp(-Δt/τ)
    with `LAST_USED_TAU = DEFAULT_DECAY_DAYS = 180` (Schmid 2014:
    long-term knowledge persistence is one phenomenon with one decay rate).
  - `lastShownAt` deliberately NOT consumed by rerank (Schmid separable
    timescales — `lastShownAt` reserved for gap detection).
  - Research grounding cited verbatim in the file header.
- **`HybridSearchEngine.hydrate()` LEFT JOIN entry_usage** — only place
  hub-local usage touches the retrieval pipeline.
- **`GapsEngine`** (`lib/gaps.js`): `sinks`, `orphans`, `untestedBeliefs`,
  `kinIsolation`. Research-grounded (Gorzelak 2015, Huggett 2007 P-MAK,
  Simard 2016, Pickles 2016, Lopez de Prado, Taleb). Two detectors are
  Phase 0.5 feature-flag-gated (see "Phase 0.6 follow-up" below).
- **GraphEngine extensions** (`lib/graph-engine.js`):
  - `findAllShortestPaths(...)` — multi-path BFS (returns ALL shortest paths).
  - `detectAutoEdges(projectId)` — description-mention candidate edges,
    longest-name-first dedup, opt-in (caller invokes when wanting refresh).
  - `getStats({ withHubs?, withBreakdown? })` — opt-in extras (top 5 hubs,
    by-project / by-type counts). Backwards-compat: `getStats()` with no
    args returns the original three-key shape.
- **`NullSigningService`** (`adapters/NullSigningService.js`) — Null Object
  pattern (Woolf 1998); always-valid `verify()`, empty-string `sign()`. For
  local-mode deployments where cryptographic signing is not required.
- **`buildLocalRegistry({ dataDir })`** (`lib/buildLocalRegistry.js`) —
  composition root for local-mode `@meridian/core`. Wires `NullSigningService`
  + `KBStore` + `HybridSearchEngine` + `GraphEngine` + `GapsEngine` +
  `NullDomainAdapter`. "Recall = local mode of Meridian" at the code level.
  Exported from `@meridian/core`.
- **better-sqlite3** pinned to `^12.9.0` (was `^11.0.0`) — required for
  Node v24 binary compat with downstream consumers.

### Phase 0.5 scope discipline (Option A — original sprint scope)

These detectors are feature-flag-gated and return `{ skipped: true, reason: ... }`
when their input infrastructure is absent:

- `GapsEngine.detectSinks()` — gated on (a) `queries` table presence AND
  (b) `sink_detection` feature flag. Without query logging there is
  nothing to detect.
- `GapsEngine.detectKinIsolation()` — gated on at least one entry having
  a `kin:` tag. Without kin tagging, every entry is "isolated" — a
  meaningless detection.

`GapsEngine.detectOrphans()` and `findUntestedBeliefs()` are fully active.

### Phase 0.6 follow-up (queued for the next harvest sprint)

Engine-relevant Recall modules NOT yet ported. Each unblocks a feature
that's currently skipped or partially implemented:

| Module | Ports / unlocks |
|---|---|
| `~/.recall/lib/query-logger.js` | populates `queries` table → `detectSinks()` becomes active |
| `~/.recall/lib/kin-tagger.js` | populates `kin:*` tags → `detectKinIsolation()` becomes active |
| `~/.recall/lib/fusion.js` (the merge OPERATION) | currently v4 schema has `fusion.*` FIELDS but Meridian has no merge operation. Vogel & Dussutour 2016 / Boisseau 2016 / Margulis 1998 / Huggett 2007 grounded |
| `~/.recall/lib/deduplicator.js` | duplicate detection (pairs with fusion) |
| `~/.recall/lib/conflict-resolver.js` | inhibitory edge handling |
| `~/.recall/lib/habituation.js` | multi-timescale decay (Schmid 2014) — currently single τ=180 across all timescales |
| `decay_exempt` SQL column on `entries` | currently lives in JSON blob as `confidence.exempt`; SQL filter dropped from `detectOrphans` until Phase 0.6 mirrors it as an indexed column |

Phase 0.6 estimate: ~12-15h. Tracked separately; does not block 0.2.0 release.
