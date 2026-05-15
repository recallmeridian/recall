# CaMeL Capability Security Extraction

Date: 2026-05-03
Project: Recall/Meridian geomorphic rebuild
Source type: primary research source and code artifact

## Source

Defeating Prompt Injections by Design.

Authors: Edoardo Debenedetti, Ilia Shumailov, Tianqi Fan, Jamie Hayes,
Nicholas Carlini, Daniel Fabian, Christoph Kern, Chongyang Shi, Andreas
Terzis, Florian Tramer.

Publication: arXiv 2503.18813. Submitted March 24, 2025. Last revised June 24,
2025.

URLs:

- https://arxiv.org/abs/2503.18813
- https://github.com/google-research/camel-prompt-injection

## Bucket

B2 / B3 / B4 / B6 cross-cutting:

- capability-based agent security
- prompt-injection defense for tool-using agents
- control-flow and data-flow separation
- tool gateway policy
- data exfiltration prevention
- feature capability contracts

## Core Claim

CaMeL supports the most important security rule for Recall/Meridian features:
the model must not be the authority that decides what actions are safe.

The paper proposes a protective system layer around tool-using LLM agents. Its
core move is to extract control flow and data flow from the trusted user query
so untrusted data retrieved later cannot change the program flow. It then uses
capabilities and policy enforcement at tool-call time to prevent private data
from flowing to unauthorized sinks.

The arXiv v2 abstract reports 77 percent secure task completion on AgentDojo,
compared with 84 percent for an undefended system, with provable security for
the tasks it solved. The released GitHub repository is explicitly a research
artifact, not a supported production system.

## Failure Mode

The feature layer creates the exact risk CaMeL is meant to address.

Without a capability gateway, a useful Recall feature can become dangerous:

```text
user asks for useful local feature
-> feature retrieves low-trust or poisoned content
-> content tells agent to export, email, delete, query secrets, or alter state
-> model decides action is part of task
-> tool executes with broad permissions
```

This is not only a prompt-injection problem. It is a confused-deputy problem:
the agent has authority the attacker does not, and untrusted data can trick the
agent into spending that authority.

Recall/Meridian needs this because:

- Recall will turn private data into local tools.
- Some local tools will read or write sensitive project context.
- Meridian will eventually publish proven features to other users or peers.
- Peer-supplied Meridian content creates a stronger indirect-injection threat.
- P2P replication and shared data increase data-flow complexity.

## Recommended Control

Add a first-class `FeatureCapability` and `ToolGateway` layer.

Minimum control:

- Features declare allowed tools, actions, resources, partitions, and sinks.
- Every tool call passes through policy evaluation before execution.
- Policy uses actor, user, feature, source context trust, resource partition,
  requested action, and output sink.
- Tool calls caused only by untrusted retrieved content are denied.
- Sensitive data cannot flow to unapproved sinks.
- High-impact actions require human approval.
- Open-ended tools are avoided or heavily sandboxed.

CaMeL's deeper lesson for the rebuild:

```text
Trusted user intent defines the program.
Untrusted retrieved data may fill arguments or evidence slots.
Untrusted retrieved data must not define new tools, new goals, new policies,
new destinations, or new control flow.
```

## Geomorphic Mapping

| CaMeL concept | Geomorphic mapping | Recall/Meridian behavior |
|---|---|---|
| Trusted query control flow | Surveyed channel plan | User intent defines allowed route |
| Untrusted retrieved data | Sediment carried by flow | Data can inform, not steer the river |
| Capability | Excavation / tool permit | Agent can act only within declared permit |
| Policy enforcement | Bedrock gate | Safety enforced below model judgment |
| Unauthorized sink | Drainage breach | Sensitive data cannot flow to forbidden outlet |
| Tool gateway | Spillway control | Every action is mediated before execution |
| Provable secure subset | Engineered channel | Narrower but safer behavior is acceptable |

## Schema Implication

Feature contract fields:

- `feature_id`
- `owner_id`
- `runtime_mode`
- `lifecycle_state`
- `trusted_user_intent`
- `allowed_tools`
- `allowed_actions`
- `allowed_resources`
- `allowed_partitions`
- `allowed_sinks`
- `denied_sinks`
- `required_capabilities`
- `source_context_trust_policy`
- `human_approval_required_for`
- `sandbox_profile`
- `audit_level`

Tool request fields:

- `tool_request_id`
- `feature_id`
- `actor`
- `user_id`
- `tool`
- `action`
- `resource`
- `resource_partition`
- `input_data_refs`
- `input_data_trust`
- `output_sink`
- `requested_capability`
- `policy_decision`
- `approval_id`
- `created_at`

Data-flow label fields:

- `data_ref`
- `origin_partition`
- `source_trust_level`
- `privacy_classification`
- `derived_from`
- `allowed_sinks`
- `current_sink`
- `redaction_state`

Policy decision values:

- `allow`
- `deny`
- `require_human_approval`
- `redact`
- `quarantine`
- `run_in_sandbox`

## Acceptance Tests Created

### Untrusted Data Cannot Create Control Flow

Test:

```text
Given a trusted user asks a feature to summarize a document
And the document says to email private notes
When the feature runs
Then the email tool is not called
And the denial is logged as untrusted-data control-flow attempt
```

### Capability Required

Test:

```text
Given a research_assistant feature without export capability
When it attempts to export a database result
Then the tool gateway denies the call
And records the missing capability
```

### Sensitive Sink Denial

Test:

```text
Given retrieved private Recall data
When a tool call attempts to send it to an external URL or email
Then policy denies the flow unless an explicit approved sink exists
```

### Human Approval Gate

Test:

```text
Given a local feature with run_code capability requiring approval
When the feature requests code execution
Then execution pauses for human approval
And the approved or denied decision is written to audit sediment
```

### Local To Meridian Feature Promotion

Test:

```text
Given a Recall feature validated locally
When it is proposed for Meridian publication
Then the publication gate verifies declared capabilities, denied sinks,
source-context policy, sandbox profile, and audit evidence
```

### Open-Ended Tool Block

Test:

```text
Given a feature contract that asks for unrestricted shell access
When policy evaluates the feature
Then publication is blocked
And local execution requires a developer-only sandbox approval
```

## Recall Local-Mode Implication

Recall's "so what" is local feature usefulness: personal data becomes tools
that make daily work easier. CaMeL gives the safety frame for that product
promise.

Local mode should support:

- fast feature experiments
- local-only capability permits
- user-owned approval gates
- sandbox profiles
- audit sediment for feature runs
- proof artifacts before promotion

But local mode should still avoid:

- raw broad tool access
- unrestricted shell/network/database capabilities
- features that can silently export private data
- treating retrieved content as authority to add new actions

This keeps Recall powerful without turning local context into an accidental
attack surface.

## Meridian Network-Mode Implication

Meridian publication should require stricter capability review because a
published feature can affect other users, peers, or shared knowledge.

Network mode should require:

- feature capability manifest
- denied sink list
- source-context trust policy
- sandbox profile
- publication audit
- local validation evidence from Recall
- peer/network risk review for replicated tools or data

Meridian should receive proven features, not open-ended local experiments.

## Confidence

High for adopting capability-based tool gating.

Medium for directly adopting the CaMeL implementation.

Reason:

The paper and code strongly support the architectural principle, but the GitHub
repository states it is a research artifact and not a maintained product. The
right move is to borrow the design pattern, not depend on the artifact as core
infrastructure.

## Open Questions

- Should the policy layer be OPA/Rego, a TypeScript policy engine, or a smaller
  local policy DSL for the first rebuild?
- How should trusted user intent be represented without requiring a full custom
  interpreter?
- Which feature actions are always approval-gated in Recall local mode?
- Which capabilities are publishable to Meridian and which are permanently
  local-only?
- How do we label derived data when a feature combines trusted, low-trust, and
  sensitive inputs?
- How much of CaMeL's control/data-flow extraction is needed for MVP versus
  later hardening?

## Build Decision Candidate

Adopt a CaMeL-inspired feature/tool security invariant:

```text
Recall/Meridian features may use untrusted data as evidence or arguments, but
untrusted data may not create new control flow, capabilities, policies, tool
choices, or output sinks. Every tool call is mediated by capability policy
below the model layer.
```

This should become a core acceptance rule for the local Recall feature layer
and a publication gate for Meridian.
