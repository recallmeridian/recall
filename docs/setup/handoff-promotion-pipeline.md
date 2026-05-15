# Handoff Promotion Pipeline (Interim — Trace Optimizer Stub)

This document describes the interim surface that closes the IL→KB promotion gap until the planned Trace Optimizer feature ships. Everything in this pipeline is **explicitly scoped as a stub** — the Trace Optimizer's planned ports will absorb each piece, and this file documents the migration path.

## Why this exists

The 2026-04-26 → 2026-05-12 open-source release sprint produced 119 commits + 43 agent handoffs + **0 decision-log entries** in the KB. The IL pipeline (agent-handoff record → hard-cases mine → trace-to-skill) was running fine; what was missing was the final hop from IL artifacts to KB entries. This pipeline supplies that hop.

## The pipeline

```
[Codex / Claude / jcode session]
        │
        ▼
[handoff.json under docs/agent-handoffs/]
        │
        ├─ git commit ──▶ scripts/hooks/pre-commit-handoff-validate.sh ──▶ blocks if significant handoff is missing promotion fields
        │
        ▼
scripts/watch-handoffs.js  (long-running daemon)
        │
        ├─ intelligence agent-handoff-check --strict-significance
        ├─ intelligence agent-handoff  (records to KB)
        └─ intelligence handoff-promote  (tiered draft queue under ~/.recall/pending-promotions/<project>/)
        │
        ▼
[Auto-promote drafts (confidence >= 0.8) — review then run recall_decision/milestone/kb add]
[Queue drafts (0.5 ≤ confidence < 0.8) — human review required]
[Discarded (< 0.5)]
```

## Components

### 1. Significance + promotion-readiness validator
**Where:** `lib/agent-handoff-ledger.js` — `isSignificantHandoff()` + `validatePromotionReadiness()`.
**Exposed as:** `intelligence agent-handoff-check <path> --strict-significance`.
**Trace Optimizer absorbs into:** `TraceNormalizerPort` (significance classification) + `PromotionGatePort` (readiness gate).

### 2. Pre-commit enforcement hook
**Where:** `scripts/hooks/pre-commit-handoff-validate.sh`.
**Install:** `cp scripts/hooks/pre-commit-handoff-validate.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit`.
**Escape:** `RECALL_SKIP_HANDOFF_VALIDATE=1 git commit ...` (log every use).
**Trace Optimizer absorbs into:** `VerificationRunnerPort` (pre-flight validation step).

### 3. Tiered draft producer
**Where:** `lib/handoff-promotion.js` — `buildPromotionQueue()`.
**Exposed as:** `intelligence handoff-promote --project <id> --since <date>`.
**Tiers:** auto-promote (≥0.8), queue (≥0.5), discard (<0.5).
**Provenance:** every draft tagged `author_type: 'il-auto-promoted'` + sourceHandoffId + confidence.
**Trace Optimizer absorbs into:** `MeridianPromotionPort` (writes drafts directly into Meridian, bypassing this on-disk staging layer).

### 4. Event-driven daemon
**Where:** `scripts/watch-handoffs.js`.
**Run:** `node scripts/watch-handoffs.js docs/agent-handoffs recall-dev`.
**Trace Optimizer absorbs into:** `AgentTraceIngestPort` (becomes a registered listener instead of a standalone script).

## Migration when Trace Optimizer ships

When the Trace Optimizer feature ships per [the existing plan entry](../../plans/2026-04-30-trace-optimizer-early.md), it replaces this surface piece by piece:

| Interim surface | Trace Optimizer port |
|---|---|
| `intelligence agent-handoff-check --strict-significance` | `PromotionGatePort.gate(traceRun)` |
| `intelligence handoff-promote` | `MeridianPromotionPort.promote(candidate)` |
| `scripts/watch-handoffs.js` | `AgentTraceIngestPort` (subscriber) |
| `scripts/hooks/pre-commit-handoff-validate.sh` | `VerificationRunnerPort.preflight(traceRun)` |
| `~/.recall/pending-promotions/` directory | Internal promotion queue managed by the port |

The migration is additive: the Trace Optimizer ports route through `@meridian/core`, so the on-disk drafts under `~/.recall/pending-promotions/` remain usable during the transition. Drafts already produced by this interim surface are paste-compatible with the `recall_decision` / `recall_milestone` / `recall_kb` MCP tools and can be approved manually.

## Discipline

This pipeline ports the Truth/Evidence/Promotion doctrine (decision-1777317024151) to the handoff layer. The doctrine was originally written for code cutovers; the launch sprint demonstrated that **knowledge promotion needs the same gates**. The G-X / G-T / G-E rubric maps:

- **G-X (Executability)** → the handoff validator (`agent-handoff-check`) — does the handoff actually exist and parse?
- **G-T (Truth integrity)** → `--strict-significance` — does the significant handoff carry the evidence required to promote?
- **G-E (Equivalence evidence)** → confidence scoring + manual review of the 0.5-0.8 tier — does the draft preserve the original work's semantics?

Promotions skip none of these gates. Auto-promotion is auto-staging into a draft directory; the final write to the KB still goes through a human or, eventually, the Trace Optimizer's typed promotion port.
