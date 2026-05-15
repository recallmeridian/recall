# OWASP Coverage Matrix for Recall/Meridian

Date: 2026-05-03
Status: active coverage map

## Scope

This matrix maps the Recall/Meridian geomorphic security layer against the
security research corpus that informs the implementation.

Primary Recall research entries:

- `owasp-llm-top10-2025`
- `owasp-mcp-top10-2025`
- `owasp-llm06-agent-security-2025`
- `spotlighting-2024-indirect-prompt-injection`
- `microsoft-msrc-2025-indirect-prompt-injection-defense`
- `camel-2025-defeating-prompt-injections`
- `rag-poisoning-security-architecture-2026`
- `vector-db-multitenancy-rag-2024`
- `microsoft-presidio-pii-redaction`
- `postgres-rls-vault-zero-trust-2025`

This is a coverage map, not a security-completeness claim.

## LLM Application Risks

| Risk | Recall/Meridian mapping | Current controls | Tests | Gap | Priority |
|---|---|---|---|---|---|
| LLM01 Prompt Injection | Polluted inflow, malicious retrieved data, imported chat/history attacks | `quarantine-routing`, `context-spotlighting`, `retrieval-partition-policy`, publication denial | `geomorphic-security-fixtures.test.js`, `context-spotlighting.test.js`, `retrieval-partition-policy.test.js`, `meridian-publication-policy.test.js` | No end-to-end import -> quarantine/candidate -> retrieval -> tool gate -> audit test | P0 |
| LLM02 Sensitive Information Disclosure | Sensitive Vault, private notes, secrets in imported history, exports | `publication-policy` secret-shaped value denial; `feature-capability` hard-blocks `sensitive_vault`; audit redaction | `meridian-publication-policy.test.js`, `feature-capability.test.js`, `geomorphic-security-fixtures.test.js` | No Sensitive Vault preflight doc; no DLP/PII redaction-map test for imported content | P1 |
| LLM03 Supply Chain | Plugins, MCP servers, feature manifests, adjacent repos | `AGENTS.md` local-only rule; no live MCP trust registry yet | none specific | Need signed/approved feature manifest policy and MCP/tool provenance check | P2 |
| LLM04 Data and Model Poisoning | Poisoned RAG docs, poisoned memories, candidate/trusted promotion abuse | `quarantine-routing`, `retrieval-partition-policy`, publication policy denies candidate/quarantine | `geomorphic-security-fixtures.test.js`, `retrieval-partition-policy.test.js`, `push-publication.test.js` | No promotion event contract; no poisoning regression fixtures from incident research | P0 |
| LLM05 Improper Output Handling | Model output becomes SQL/shell/HTML/URLs/files | `output-validation` validates sink-specific outputs; `feature-capability` denies high-risk actions without policy | `output-validation.test.js`, `feature-capability.test.js` | Not wired into live tool/browser/DB/file sinks yet | P0 |
| LLM06 Excessive Agency | Agent/tool overreach, model-driven exports/email/code execution | `feature-capability` deny-by-default, human approval, hard-blocked origins | `feature-capability.test.js` | Not wired into actual feature/tool runner yet | P0 |
| LLM07 System Prompt Leakage | Prompt exposure requests in imports or retrieved docs | `quarantine-routing` catches common reveal-system-prompt strings; Spotlighting marks retrieved data as evidence only | `geomorphic-security-fixtures.test.js`, `context-spotlighting.test.js` | Known bypass fixtures still route candidate until stronger classifier lands | P1 |
| LLM08 Vector and Embedding Weaknesses | Cross-partition vector leakage, unauthorized similarity search, poisoned embeddings | `retrieval-partition-policy` enforces partition filtering contract; research says namespace isolation later | `retrieval-partition-policy.test.js` | No vector-index adapter namespace enforcement; no integration test against actual search engine | P0 |
| LLM09 Misinformation | Low-quality/unverified Recall entries becoming authoritative | Publication policy blocks drafts/candidates; retrieval policy defaults trusted-only | `meridian-publication-policy.test.js`, `retrieval-partition-policy.test.js` | No confidence/freshness/source-quality acceptance matrix for geo reframe | P2 |
| LLM10 Unbounded Consumption | Resource abuse through imports/search/tool loops | none specific | none specific | Need rate/size limits for imports, retrieval, feature execution, and audit writes | P2 |

## MCP and Tool Risks

| Risk area | Recall/Meridian mapping | Current controls | Tests | Gap | Priority |
|---|---|---|---|---|---|
| Excessive tool permissions | Feature capability permits | `feature-capability` explicit `can`, `cannot`, and `requires_approval` policy | `feature-capability.test.js` | Not wired into real tool/feature execution | P0 |
| Tool poisoning / malicious tool descriptions | Feature registry and MCP tool registry | none specific | none specific | Need tool manifest allowlist, signed descriptions, and description-as-data treatment | P1 |
| Command injection | Shell/code execution features | `feature-capability` denies `run:code`/`run:shell` unless explicitly allowed | `feature-capability.test.js` | No shell argument/schema validator or sandbox contract | P1 |
| Context over-sharing | Too much Recall memory passed to MCP/tools | `retrieval-partition-policy` filters retrieval; Spotlighting wraps low-trust context | `retrieval-partition-policy.test.js`, `context-spotlighting.test.js` | No per-tool context budget or allowed-context policy | P1 |
| Token/credential exposure | Secrets in config/imports/tool calls | `publication-policy` blocks secret-shaped values; audit sediment redacts denied keys | `meridian-publication-policy.test.js`, `geomorphic-security-fixtures.test.js` | Need DLP/Presidio preflight for import and feature inputs | P1 |
| Shadow or unapproved MCP servers | Unknown local tool servers | none specific | none specific | Need local MCP inventory/check command before live feature tools | P2 |
| Missing audit/telemetry | Tool calls and denials invisible | `audit-sediment`; modules return audit events | `geomorphic-security-fixtures.test.js`, `feature-capability.test.js`, `retrieval-partition-policy.test.js` | Not all modules persist audit events through a shared writer adapter | P0 |

## Current Control Inventory

| Control | File | Status |
|---|---|---|
| Quarantine/candidate intake routing | `lib/quarantine-routing.js` | implemented, dry-run |
| Publication policy deny gate | `lib/publication-policy.js` | implemented, dry-run/live push dry-run path |
| Publication envelope placeholder | `lib/publication-envelope.js` | implemented, null-local signing placeholder |
| Audit sediment hash chain | `lib/audit-sediment.js` | implemented |
| Spotlighting wrapper | `lib/context-spotlighting.js` | implemented, not wired |
| Feature capability gate | `lib/feature-capability.js` | implemented, not wired |
| Retrieval partition policy | `lib/retrieval-partition-policy.js` | implemented, not wired |
| Output validation gate | `lib/output-validation.js` | implemented, not wired |
| No OneDrive/downloads active-source rule | `AGENTS.md`, `.gitignore` | implemented |

## Highest-Priority Gaps

### P0-1 End-To-End Geomorphic Security Flow

Status: implemented as composed test; not live wiring

Build an end-to-end test that composes the controls:

```text
external/imported content
-> classifyImportedContentForRouting
-> appendAuditEvent
-> filterRetrievalCandidates / buildRetrievalContext
-> spotlight low-trust allowed content
-> validateModelOutput
-> canInvokeTool
-> appendAuditEvent
```

Acceptance:

- quarantined content never appears in normal retrieval
- candidate content appears only in explicit candidate/FROM * paths and is
  Spotlight-wrapped
- unsafe model outputs are rejected or sanitized before tool/browser/file/DB
  sinks
- untrusted candidate values cannot drive high-risk tools without approval
- quarantine values cannot drive high-risk tools even with approval policy
- audit events preserve decisions without raw hostile text

Implementation:

- `test/e2e-geomorphic-security-flow.test.js`

Validated behavior:

- hostile imported content routes to `quarantine_basin`
- non-hostile external content routes to `candidate_basin`
- normal retrieval returns neither quarantine nor candidate content
- explicit candidate retrieval returns candidate content with Spotlighting
- unsafe output is denied before sinks
- candidate-origin high-risk export is denied
- external email requires human approval
- quarantine-origin promotion is hard-blocked
- audit sediment records the chain without raw hostile/candidate text

### P0-2 Live Retrieval Integration

Status: dry-run CLI wrapper implemented; live filtering not enabled by default

Wire `retrieval-partition-policy` into actual Recall search/retrieval after a
small current-state audit of the search command and adapters.

Acceptance:

- normal CLI/API search excludes `candidate_basin`, `quarantine_basin`, and
  `sensitive_vault`
- explicit candidate/quarantine modes are gated and visible
- vector-search adapters receive partition filters

Dry-run implementation:

- `lib/search-security-dry-run.js`
- `test/search-security-dry-run.test.js`
- `node bin\meridian.js search <project> <query> --security-dry-run`

Observed dry-run limitation:

- existing research entries without explicit partition/trust metadata normalize
  to `trusted_kb/trusted`; a later metadata migration should stamp provenance,
  partition, and trust explicitly instead of relying on defaults.

### P0-3 Output And Feature Runner Integration

Wire `output-validation` and `feature-capability` into the first local Recall
feature/tool runner.

Acceptance:

- model outputs are validated against sink-specific rules before use
- every feature action passes through `canInvokeTool`
- denials are audit-sediment events
- human-approval-required returns a pending state, not an executed action

## Near-Term P1 Gaps

- Sensitive Vault preflight: RLS/redaction/no-raw-SQL/access-request design.
- DLP/Presidio import preflight for pasted/imported history.
- Stronger output validators: full JSON schema library, richer Markdown/HTML
  sanitizer, SQL template registry, and shell sandbox integration.
- Incident-backed regression fixtures using sanitized real-world attack shapes.
- Tool manifest allowlist and signed tool-description policy.

## Recommendation

The next code card should be `P0-1 End-To-End Geomorphic Security Flow`.

Reason:

The individual controls now exist. The highest risk is that future sessions
wire them inconsistently. A composed test gives us a safety rail before live
search/tool integration.
