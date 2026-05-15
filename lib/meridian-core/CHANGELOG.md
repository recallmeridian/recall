# @meridian/core — Changelog

## 0.2.2 — Schema realization fix (2026-04-25)

### Fixed (BUG: silent reranker degradation)

External architectural review surfaced a critical drift between the v4.0
JSON-blob entry shape and the SQL projection used by `HybridSearchEngine`'s
hydration → reranker pipeline. Pre-0.2.2 the `entries` SQL table indexed
only `name`, `description`, `category`, `tags`, `disease_area`, `genes`,
`pathways`, `addedAt`, `updatedAt`. The reranker reads
`entry.confidence_score`, `entry.last_verified`, `entry.decay_exempt` —
flat fields that don't exist on hydrated rows. **Result: confidence-driven
and freshness-driven reranking silently degraded to neutral 1.0 in
production.** The 343/343 unit tests passed because synthetic test fixtures
provided flat fields directly, never exercising the SQL round-trip.

### Added

- `entries.confidence_score REAL` — projected from `entry.confidence.value`
- `entries.last_verified TEXT` — projected from `entry.confidence.lastVerified`
- `entries.decay_days INTEGER` — projected from `entry.confidence.decayDays`
- `entries.decay_exempt INTEGER` — projected from `entry.confidence.exempt` (bool → 0/1)
- `entries.practical_value TEXT` — projected from `entry.practicalValue` (queryable)
- `entries.source_trust_id TEXT` — projected from `_extensions.source_trust_id` (kin filter)
- `_addColumnIfMissing()` helper — idempotent ALTER for DBs created under 0.2.0/0.2.1
- 5 new integration tests exercising the addEntry → SQL projection → reranker round-trip

### Changed

- `_indexEntry()` now mirrors the v4 confidence sub-object + `practicalValue`
  + `_extensions.source_trust_id` into the new SQL columns at write time
- `packages/server/src/routes/v2-entries.js` — accepts both v4 `confidence.value`
  and pre-v4 `confidence.score` (backward-compat for old payloads)
- `packages/server/src/routes/entries.js` — same backward-compat handling
- `packages/core/README.md` — v3.0 → v4.0; addEntry example uses v4 sub-object shape

### Test count: 363/363 (was 358 pre-0.2.2)

## 0.2.1 — Warm-context snapshots (2026-04-25)

### Added (non-breaking)

- **`SnapshotService`** (`lib/snapshot.js`) — generates pre-ranked markdown
  context bundles per project. Composite score ranking using the same
  multiplicative blend as the reranker (confidence × freshness × usage).
  No query in play — surfaces "highest-quality entries right now", not
  "best matches for query X".
- **`registry.get('snapshot')`** wired into `buildLocalRegistry`. Recall
  (Phase 1) and any future consumer accesses snapshot through the same
  composition root.
- **Token-budget option** — `generate({ projectId, tokenBudget, maxEntries })`
  caps output to a target budget. Default 4000 tokens (~1k word context,
  comfortably fits a CLAUDE.md preamble).
- **Pure domain service** — returns `{markdown, metadata}` value object;
  caller decides where to write. Engine layer stays side-effect-free.
- **`SnapshotService` exported** from `@meridian/core` for callers needing
  to construct it directly.

### Use case

Replace per-session KB cold-starts with a single cached context snapshot.
Expected savings: ~6,500 tokens per Claude Code session vs reading raw
entries. One-time generation cost ~1,000 tokens, paid back on the second
session.

### Tests

15 new (4 ranking, 4 renderMarkdown, 5 generate, 1 registry integration,
1 export verification). 358/358 total passing.

## 0.2.0 — MIF v4.0 + Phase 0.5 engine harvest from Recall (2026-04-25)

See BREAKING.md for the full breaking-change record.
