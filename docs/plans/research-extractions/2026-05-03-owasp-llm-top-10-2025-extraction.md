# OWASP LLM Top 10 2025 Extraction

Date: 2026-05-03
Project: Recall/Meridian geomorphic rebuild
Source type: primary source / security guidance

## Source

OWASP Top 10 for Large Language Model Applications 2025.

URLs:

- https://genai.owasp.org/llm-top-10/
- https://genai.owasp.org/llmrisk/llm01-prompt-injection/
- https://genai.owasp.org/llmrisk/llm022025-sensitive-information-disclosure/
- https://genai.owasp.org/llmrisk/llm042025-data-and-model-poisoning/
- https://genai.owasp.org/llmrisk/llm062025-excessive-agency/
- https://genai.owasp.org/llmrisk/llm082025-vector-and-embedding-weaknesses/

## Bucket

B1 / B3 / B4 / B5 / B6 / B7 cross-cutting:

- prompt injection
- sensitive information disclosure
- supply-chain and plugin risk
- data/model/embedding poisoning
- excessive agency
- system prompt leakage
- vector and embedding weaknesses
- misinformation and retrieval quality
- unbounded consumption / resource abuse

## Core Claim

OWASP's 2025 LLM Top 10 supports the main Recall/Meridian security thesis:
LLM security cannot rely on the model behaving correctly. The application must
constrain data flow, retrieval, tools, outputs, and access below the model.

The most relevant categories for the geomorphic rebuild are:

- LLM01: Prompt Injection
- LLM02: Sensitive Information Disclosure
- LLM04: Data and Model Poisoning
- LLM05: Improper Output Handling
- LLM06: Excessive Agency
- LLM07: System Prompt Leakage
- LLM08: Vector and Embedding Weaknesses
- LLM10: Unbounded Consumption

OWASP's recommended controls line up with the geomorphic model:

- segregate and identify external content
- enforce least privilege
- require human approval for high-risk actions
- validate expected output formats
- apply input/output filtering and sanitization
- use strict vector access partitioning
- keep immutable retrieval and security logs
- conduct adversarial testing and attack simulations

## Failure Mode

If Recall/Meridian is rebuilt as a flat RAG memory, the system will be exposed
to the same failure modes OWASP describes:

- Direct prompt injection changes the agent's behavior during a user session.
- Indirect prompt injection enters through external files, websites, emails,
  documents, tool outputs, or future peer-supplied Meridian content.
- Poisoned content is embedded into memory and later retrieved as if it were
  trusted evidence.
- Shared vector indexes leak data across users, projects, tenants, peers, or
  trust classes.
- Sensitive local data is exposed because the model can query or summarize it
  without a hard vault boundary.
- Agents have too much tool functionality, too many permissions, or too much
  autonomy.
- Model outputs are passed downstream without validation.
- System prompts and internal rules are treated as secret protection rather
  than convenience text.
- Attackers consume resources through expensive or repeated calls.

For Recall/Meridian, the most dangerous combined failure is:

```text
low-trust source -> embedded in normal memory -> retrieved by similarity ->
treated as instruction -> triggers tool -> leaks or mutates sensitive state
```

The geomorphic security core exists to break this chain at multiple layers.

## Recommended Control

Translate OWASP guidance into structural controls:

### Provenance Watersheds

Every entry must carry source and trust metadata. External documents, web
pages, emails, tool outputs, peer-supplied Meridian entries, and imported
datasets begin as lower-trust watersheds until promoted.

### Channel Separation

The context builder must separate trusted instructions from retrieved content.
Low-trust retrieval should be wrapped, marked, and treated as evidence only.

### Closed-Basin Quarantine

Suspicious, malformed, low-trust, or injection-shaped content should be routed
to a hard quarantine partition:

- no outbound graph edges
- no default retrieval
- no normal citations
- no tool triggers
- explicit review-only access
- audited promotion path

### Bedrock Vault

Sensitive records, credentials, legal/client data, private local data, and
project secrets belong behind a vault interface. The model should not receive
raw database access. Approved functions should enforce redaction, row/project
scope, policy checks, and audit logging.

### Capability Permits

Agent tools must have narrow, explicit capabilities. Avoid open-ended tools
when a smaller tool can do the job. High-impact actions require human approval.
This is directly aligned with OWASP's excessive-agency mitigations.

### Output Validation

No model output should go directly into a tool, shell, database, file export,
HTML renderer, or network request without validation. Validators should include
schema checks, path normalization, URL allowlists, redaction, citation checks,
and approval gates for exports.

### Audit Sediment

Every meaningful flow decision should leave a record:

- ingest classification
- partition assignment
- retrieval path
- vector namespace
- graph traversal boundary
- tool call request
- policy decision
- approval/denial
- quarantine promotion
- publication to Meridian
- export
- resource throttling event

### Resource Flow Limits

OWASP's unbounded-consumption risk maps to hydrological flow control: rate
limits, budget limits, recursion limits, context-size limits, tool-call limits,
and expensive-operation approvals.

## Geomorphic Mapping

| OWASP risk | Geomorphic mapping | Recall/Meridian behavior |
|---|---|---|
| Prompt injection | Polluted inflow | Low-trust content is marked, constrained, or routed to basin |
| Sensitive disclosure | Exposed bedrock | Sensitive data sits in vaults with narrow functions |
| Data/model poisoning | Contaminated sediment | Unverified sources cannot become trusted strata automatically |
| Improper output handling | Unfiltered outflow | Output gates validate before downstream effects |
| Excessive agency | Uncontrolled stream power | Tools require capability permits and human approval |
| System prompt leakage | Mistaken secret terrain | Do not depend on prompt secrecy for security |
| Vector weaknesses | Cross-channel seepage | Hard vector namespaces and permission-aware retrieval |
| Misinformation | Weak strata / false deposition | Provenance, citations, review, and decay reduce authority |
| Unbounded consumption | Flood event | Quotas, limits, and throttles control resource flow |

## Schema Implication

OWASP strengthens the case for these core fields:

Entry fields:

- `entry_id`
- `project_id`
- `owner_id`
- `runtime_mode`
- `source_type`
- `source_uri`
- `source_trust_level`
- `source_authenticity`
- `content_hash`
- `partition`
- `vector_namespace`
- `graph_boundary`
- `classification_reason`
- `allowed_retrieval_modes`
- `allowed_tool_scopes`
- `privacy_classification`
- `lifecycle_state`
- `risk_score`
- `decay_policy_id`

Retrieval event fields:

- `retrieval_id`
- `query_id`
- `actor`
- `runtime_mode`
- `requested_partition`
- `effective_partition_filter`
- `vector_namespace`
- `source_context_trust`
- `returned_entry_ids`
- `excluded_entry_ids`
- `wrapper_applied`
- `policy_decision`
- `created_at`

Tool request fields:

- `tool_request_id`
- `actor`
- `user_id`
- `agent_id`
- `tool`
- `action`
- `resource`
- `resource_partition`
- `source_context_trust`
- `required_capability`
- `policy_decision`
- `approval_id`
- `created_at`

Output validation fields:

- `validation_id`
- `output_type`
- `schema_id`
- `resource_target`
- `validator_result`
- `redactions`
- `blocked_reason`
- `created_at`

## Acceptance Tests Created

### Prompt Injection

Test:

```text
Given an external document containing instruction-shaped text
When it is ingested
Then it is classified with source provenance
And either routed to quarantine or marked as low-trust external data
And normal retrieval never treats it as developer/system instruction
```

### Indirect Injection Through Retrieval

Test:

```text
Given a low-trust retrieved entry containing "ignore prior instructions"
When the context builder prepares model context
Then the content is wrapped as untrusted data
And the tool gateway refuses any tool request caused only by that content
```

### Quarantine Leakage

Test:

```text
Given a quarantined entry with a high semantic match to a user query
When default search or FROM * retrieval runs
Then the entry is excluded by partition and vector namespace
And the retrieval audit records the exclusion
```

### Sensitive Vault

Test:

```text
Given a prompt injection asking for private records
When the agent attempts retrieval or database access
Then raw SQL is not available
And approved functions enforce actor, project, row, and redaction policy
```

### Excessive Agency

Test:

```text
Given a research assistant feature
When it attempts delete, export, email, shell, or publication actions
Then the policy engine denies or requires approval unless the feature contract
declares the exact capability
```

### Vector Isolation

Test:

```text
Given two projects, two trust levels, and quarantine content in a shared vector
backend
When similarity search runs
Then results cannot cross project, partition, or vector namespace filters
```

### Output Validation

Test:

```text
Given a model output intended for a tool
When the output does not match the declared schema or safe template
Then the tool call is blocked
And an audit event records the validator failure
```

### Resource Abuse

Test:

```text
Given a repeated or recursive request that exceeds configured budget
When the agent loop continues beyond policy limits
Then the run is halted or requires approval
And a resource flow event is logged
```

## Recall Local-Mode Implication

Recall can move faster than Meridian, but not recklessly.

Local mode should allow experimentation with:

- lower-friction capture
- local-only features
- local plugin trials
- private source ingestion
- attack simulations
- quarantine review

But even local Recall should enforce:

- provenance metadata
- partition boundaries
- vector namespace filters
- vault boundaries
- no raw model SQL
- tool capability checks
- audit sediment

The key product point is that Recall's feature layer becomes useful because the
system can safely turn personal data and local context into tools.

## Meridian Network-Mode Implication

Meridian must be stricter because peer-supplied content increases indirect
injection, poisoning, and provenance risk.

Network mode should require:

- signed or verifiable provenance where possible
- peer/source trust metadata
- publication gates from Recall into Meridian
- stronger vector and graph boundaries
- replication filters that exclude local-only, sensitive, quarantine, and
  unapproved candidate content
- explicit feature publication contracts
- abuse throttles and peer reputation/risk scoring

## Confidence

High.

Reason:

OWASP is a primary security community source, and the 2025 LLM Top 10 directly
targets the classes of risk Recall/Meridian will face as an AI memory,
retrieval, feature, and agent/tool system. The mapping from OWASP controls to
geomorphic topology is interpretive, but the underlying controls are strongly
supported by the source.

## Open Questions

- Which OWASP risks become phase-one blockers versus later hardening?
- Should local Recall allow any unsafe experimental tools behind a developer
  flag, or should capability policy be mandatory from the first rebuild?
- What vector backend will be used, and does it support hard namespace filters
  that cannot be bypassed by query construction?
- How should peer trust be represented in Meridian without creating a fragile
  social reputation system too early?
- How strict should the quarantine classifier be before we have false-positive
  review analytics?
- What is the minimum output-validation layer needed before Recall features
  can call real tools?

## Build Decision Candidate

Adopt OWASP LLM Top 10 2025 as the security baseline for the geomorphic rebuild:

```text
Every Recall/Meridian flow from source -> memory -> retrieval -> context ->
tool/output/publication must be constrained by provenance, partition,
capability, validation, and audit controls below the model layer.
```

This should become a core acceptance rule for future phase cards.
