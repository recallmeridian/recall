# OWASP MCP Top 10 Extraction

Date: 2026-05-03
Project: Recall/Meridian geomorphic rebuild
Source type: primary security guidance / beta security taxonomy

## Source

OWASP MCP Top 10.

URL:

- https://owasp.org/www-project-mcp-top-10/

Important status note:

The OWASP page identifies the MCP Top 10 as a living document and indicates it
is currently in beta/pilot release, with a final release still listed as a
future phase. Treat it as high-signal directional guidance, not a frozen
standard.

## Bucket

B3 / B2 / B4 / B7 cross-cutting:

- MCP, plugin, connector, and supply-chain risk
- token and secret exposure
- privilege scope creep
- tool poisoning
- dependency tampering
- command injection
- context injection and over-sharing
- insufficient authentication and authorization
- audit and telemetry gaps
- shadow servers / unmanaged local services

## Core Claim

Recall/Meridian's feature layer must treat tools, connectors, plugins, and MCP
servers as security boundaries, not convenience wrappers.

OWASP's MCP risks map directly onto the Recall/Meridian product plan:

- Recall local mode will encourage experimentation with features and local
  plugins.
- Meridian network mode may eventually publish proven features and connectors.
- The same thing that makes features useful, access to tools and context, makes
  them dangerous when tokens, permissions, or context are overshared.

The architectural lesson is:

```text
Features are not just prompts. Features are capability-bearing software
objects with dependencies, credentials, tools, data flows, and audit duties.
```

## Failure Mode

The dangerous local-to-network path looks like this:

```text
quick local Recall feature
-> broad connector token
-> tool schema or dependency changes silently
-> feature works in local tests
-> feature is published to Meridian
-> peer context or malicious source manipulates it
-> tool leaks data, executes a command, or mutates shared state
```

Specific failure modes to plan against:

- Long-lived tokens are stored in logs, context, memory, or feature configs.
- A temporary capability grows into a permanent broad permission.
- A tool/plugin is poisoned through an update, duplicate tool, or misleading
  schema.
- An agent constructs shell/API/code calls from untrusted input.
- A connector accepts requests without strong actor/user/resource checks.
- Context from one task, user, project, or peer is shared into another.
- Local shadow MCP servers are created for experimentation and later forgotten.
- Tool invocations cannot be reconstructed because audit telemetry is missing.

## Recommended Control

Add a `FeatureRegistry` and `ConnectorRegistry` concept to the geomorphic core.

Minimum controls:

- Every feature declares its tools, connector dependencies, scopes, tokens,
  resource partitions, allowed sinks, and audit requirements.
- Local Recall features may be marked `local_experiment`, but still require a
  capability manifest before real tools run.
- Meridian publication requires a stricter feature review that checks
  dependency provenance, token handling, scope size, audit behavior, and context
  sharing.
- Secrets never live in prompt context, memory entries, vector embeddings,
  exported feature manifests, or audit bodies.
- Tokens should be short-lived and narrowly scoped where possible.
- Tool schemas and connector versions should be pinned or signed before
  publication.
- Shadow MCP servers should be discoverable in local diagnostics and blocked
  from Meridian publication.
- Command/shell/code execution is never a default feature capability.

## Geomorphic Mapping

| OWASP MCP risk | Geomorphic mapping | Recall/Meridian behavior |
|---|---|---|
| Token exposure | Exposed aquifer | Secrets live outside model-visible terrain |
| Scope creep | Channel widening | Capabilities expire or require review |
| Tool poisoning | Contaminated tributary | Tool provenance and schema integrity are checked |
| Dependency tampering | Faulted bedrock | Published features pin/signed dependencies |
| Command injection | Flash flood through tool channel | Tool args are validated and sandboxed |
| Intent flow subversion | River capture | Untrusted context cannot redirect the user's goal |
| Weak authz | Uncontrolled crossing | Every tool call checks actor/user/resource |
| Audit gaps | Missing sediment record | Tool/context events are immutable audit sediment |
| Shadow servers | Unmapped tributaries | Local diagnostics detect unmanaged servers |
| Context over-sharing | Basin seepage | Context is scoped by user, project, partition, and task |

## Schema Implication

Feature registry fields:

- `feature_id`
- `owner_id`
- `runtime_mode`
- `lifecycle_state`
- `local_only`
- `publishable`
- `required_tools`
- `required_connectors`
- `required_mcp_servers`
- `required_scopes`
- `scope_expiry_policy`
- `token_storage_policy`
- `allowed_context_partitions`
- `allowed_output_sinks`
- `dependency_lock_ref`
- `tool_schema_hashes`
- `audit_level`
- `last_security_review_at`

Connector registry fields:

- `connector_id`
- `connector_type`
- `owner_id`
- `runtime_mode`
- `auth_method`
- `scope_set`
- `token_lifetime`
- `secret_storage_ref`
- `allowed_features`
- `allowed_partitions`
- `allowed_actions`
- `network_access_policy`
- `version`
- `schema_hash`
- `provenance_ref`
- `risk_score`

MCP/server diagnostic fields:

- `server_id`
- `launch_source`
- `local_path`
- `owner_id`
- `declared_tools`
- `declared_scopes`
- `approved_for_recall`
- `approved_for_meridian`
- `last_seen_at`
- `security_review_state`

Audit event additions:

- `tool_schema_hash`
- `connector_id`
- `mcp_server_id`
- `scope_set`
- `token_ref`
- `context_partition_ids`
- `output_sink`
- `dependency_lock_ref`

## Acceptance Tests Created

### Secret Exposure

Test:

```text
Given a feature uses a connector token
When the feature manifest, prompt context, vector store, or audit log is read
Then the raw token is absent
And only a redacted secret reference is visible
```

### Scope Creep

Test:

```text
Given a local Recall feature was granted temporary export scope
When the scope expiry time passes
Then tool calls requiring that scope are denied
And the feature requires explicit renewal before running again
```

### Tool Poisoning

Test:

```text
Given a published feature depends on a tool schema hash
When the tool schema changes
Then the feature is blocked or returned to review
And the change is written to audit sediment
```

### Command Injection

Test:

```text
Given untrusted retrieved data contains shell or API instructions
When a feature builds a tool request
Then command/code execution is denied unless the feature has an explicit
sandboxed capability and human approval
```

### Shadow MCP Server

Test:

```text
Given an unmanaged local MCP server is discovered
When a feature tries to depend on it
Then Recall marks the dependency local_experiment only
And Meridian publication is blocked
```

### Context Over-Sharing

Test:

```text
Given two projects with separate context partitions
When a feature runs in project A
Then context from project B is unavailable unless explicitly authorized
And the retrieval event records the effective partition filter
```

### Meridian Publication Gate

Test:

```text
Given a Recall feature is proposed for Meridian publication
When publication policy evaluates it
Then the policy checks connector scopes, tool schemas, dependency lock,
secret policy, audit level, and context-sharing rules
And blocks publication on any missing control
```

## Recall Local-Mode Implication

Recall should remain the local lab, but the lab needs inventory.

Local mode can allow:

- experimental features
- local-only plugins
- connector trials
- short-lived approvals
- developer sandboxes
- private audit

But local mode should still track:

- which tools exist
- which features use them
- what scopes are granted
- where secrets live
- what context partitions are accessible
- which local servers are unmanaged

This protects the "features are the so what" product claim. The user gets real
daily tools, but those tools do not quietly become broad, untracked authority.

## Meridian Network-Mode Implication

Meridian should publish only features with clear capability and dependency
provenance.

Network mode should require:

- approved feature manifest
- approved connector/tool registry entries
- pinned/signed dependencies where possible
- no raw secret material
- clear context-sharing policy
- audit telemetry
- local Recall validation evidence
- explicit human publication approval

Meridian should not replicate local shadow tools, local-only connectors,
private tokens, quarantine content, sensitive vault references, or unreviewed
feature experiments.

## Confidence

Medium-high.

Reason:

The OWASP MCP Top 10 is directly relevant and current, but the page identifies
it as a beta/living document. The controls are still useful because they align
with OWASP LLM Top 10, CaMeL, and the Recall/Meridian architecture already
planned.

## Open Questions

- What is the minimum local feature registry needed before real connector
  tools are allowed?
- Should all connector tokens be externalized to OS keychain/secret manager
  from day one?
- How should Recall discover local MCP servers and distinguish approved from
  shadow servers?
- What dependency lock format should be used for feature publication?
- Should Meridian allow remote tool execution at all in the first network MVP?
- Which tools are permanently local-only even if the feature logic is
  publishable?

## Build Decision Candidate

Adopt a feature/plugin registry invariant:

```text
Every Recall/Meridian feature that can call tools must declare its connectors,
scopes, dependencies, context partitions, secret policy, output sinks, and audit
requirements before execution. Meridian publication requires this manifest to
pass policy review.
```

This is the bridge between Recall as local experimentation and Meridian as the
networked, decentralized version.
