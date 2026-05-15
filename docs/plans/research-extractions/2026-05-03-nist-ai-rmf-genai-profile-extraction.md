# NIST AI RMF Generative AI Profile Extraction

Date: 2026-05-03
Project: Recall/Meridian geomorphic rebuild
Source type: primary source

## Source

Artificial Intelligence Risk Management Framework: Generative Artificial
Intelligence Profile.

NIST AI 600-1. Published July 26, 2024. Updated April 8, 2026 on the NIST page.

URLs:

- https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence
- https://doi.org/10.6028/NIST.AI.600-1
- https://www.nist.gov/itl/ai-risk-management-framework

## Bucket

B1 / B4 / B7 / B8 cross-cutting:

- AI lifecycle risk management
- provenance
- pre-deployment testing
- incident disclosure
- data privacy
- information integrity
- information security
- value chain and component integration

## Core Claim

Generative AI risks must be managed across the system lifecycle, not only at
prompt time or model-output time. NIST frames the GenAI profile as a companion
to the AI RMF for helping organizations govern, map, measure, and manage risks
across design, development, deployment, operation, and decommissioning.

The profile is especially relevant because it identifies four primary GenAI
considerations:

- governance
- content provenance
- pre-deployment testing
- incident disclosure

For Recall/Meridian, this means the geomorphic rebuild should treat lifecycle,
provenance, verification, and incident/audit trails as core substrate, not
optional product polish.

## Failure Mode

If Recall/Meridian treats AI risk as a model prompt problem, the system will
miss risks that arise from:

- source data and provenance ambiguity
- incorrect or confabulated generated content
- sensitive data leakage
- information integrity failures
- information security misuse
- unsafe component/plugin/tool integration
- lack of lifecycle testing before publication
- lack of incident disclosure and audit trail after failure
- local experimental material being promoted or replicated too early

NIST's risk dimensions also warn that risks vary by lifecycle stage, scope,
source, and time scale. For the rebuild, that means a single static "trust
score" is not enough.

## Recommended Control

Translate NIST's govern/map/measure/manage lifecycle into Recall/Meridian
controls:

### Govern

- define runtime modes: Recall local mode and Meridian network mode
- define roles and capabilities for users, agents, plugins, and peers
- define publication and feature-promotion policies
- define incident/audit requirements

### Map

- require provenance metadata on every entry
- map source trust, partition, lifecycle state, and allowed retrieval modes
- identify local-only, sensitive, quarantine, candidate, and publishable
  material
- map dependencies for features/plugins before publication

### Measure

- create acceptance tests for lifecycle transitions
- measure quarantine leakage, vector leakage, graph traversal leakage, and
  policy denials
- measure retrieval quality separately for local Recall and Meridian network
  modes
- measure false positives/false negatives in quarantine routing

### Manage

- enforce partition boundaries
- require explicit promotion for candidates, quarantine exits, and feature
  publication
- use audit sediment for incident history
- decay or retire stale/weak/unsafe entries
- block replication of local-only, sensitive, or quarantined material

## Geomorphic Mapping

| NIST concept | Geomorphic mapping | Recall/Meridian behavior |
|---|---|---|
| AI lifecycle | Landscape evolution | Objects change state over time through audited transitions |
| Governance | Watershed law / terrain rules | Policies determine what can flow where |
| Content provenance | Watershed/source | Every entry records source and trust metadata |
| Pre-deployment testing | Flow simulation before release | Local Recall proof before Meridian publication |
| Incident disclosure | Sediment record | Audit events record failures, denials, promotions, and incidents |
| Data privacy | Bedrock vault | Sensitive data uses protected partition and narrow functions |
| Information integrity | Strata quality | Trusted entries require validation and citation/provenance |
| Information security | Basin/channel controls | Quarantine, policy gates, and tool capabilities restrict flow |
| Value chain integration | Tributary inspection | Plugins/connectors/features declare dependencies and trust |

## Schema Implication

The shared geomorphic substrate should include fields sufficient to map,
measure, and manage risk.

Entry/candidate fields:

- `entry_id`
- `runtime_mode`
- `partition`
- `lifecycle_state`
- `source_type`
- `source_uri`
- `source_trust_level`
- `content_hash`
- `ingested_at`
- `owner_id`
- `project_id`
- `classification_reason`
- `allowed_retrieval_modes`
- `allowed_tool_scopes`
- `privacy_classification`
- `publication_status`
- `last_reviewed_at`
- `last_accessed_at`
- `decay_policy_id`

Promotion event fields:

- `promotion_id`
- `source_id`
- `from_lifecycle_state`
- `to_lifecycle_state`
- `from_partition`
- `to_partition`
- `actor`
- `approver_id`
- `policy`
- `justification`
- `evidence_ids`
- `created_at`
- `risk_review_result`

Feature publication fields:

- `feature_id`
- `feature_lifecycle_state`
- `local_validation_refs`
- `required_partitions`
- `required_capabilities`
- `local_only`
- `publishable`
- `publication_policy_result`

Audit event fields:

- `event_id`
- `event_type`
- `actor`
- `runtime_mode`
- `resource_id`
- `resource_partition`
- `policy_decision`
- `timestamp`
- `source_context_trust`
- `risk_score`
- `redactions`
- `incident_ref`

## Acceptance Tests Created

### Lifecycle Risk

Test:

```text
Given a raw imported source in Recall local mode
When it is searched in default active mode
Then it does not appear as validated trusted knowledge until promoted
And an audit event records the promotion if promotion occurs
```

### Publication Gate

Test:

```text
Given a locally validated Recall entry
When a user attempts Meridian network publication
Then the system checks provenance, lifecycle state, privacy classification,
source trust, and audit history
And blocks publication if any required field is missing
```

### Feature Gate

Test:

```text
Given a local Recall feature that uses private project data
When a user attempts to publish the feature to Meridian
Then publication is denied unless the feature contract declares no local-only
data dependency or includes an approved redaction/export policy
```

### Incident Sediment

Test:

```text
Given a prompt-injection attempt from an imported document
When retrieval or tool execution is denied
Then an audit sediment event records source, partition, policy decision, actor,
tool/action, and denial reason
```

### Runtime Mode Boundary

Test:

```text
Given Recall local mode
When a candidate or feature is created
Then no p2p replication event is emitted
And no Meridian publication status is assigned unless explicitly requested
```

## Recall Local-Mode Implication

Recall should be optimized for safe local experimentation:

- cheap capture
- candidate staging
- local feature building
- local validation
- private audit
- local sensitive vault
- no mandatory replication

NIST's lifecycle framing supports this because local proof is a form of
pre-deployment testing before network publication.

## Meridian Network-Mode Implication

Meridian should require stronger gates:

- publication policy
- signed provenance
- peer trust handling
- publication audit
- incident disclosure path
- network replication boundary
- conflict/lineage handling

Meridian should receive only promoted knowledge or proven features, not raw
local experiments.

## Confidence

High.

Reason:

This is an official NIST publication and directly supports lifecycle risk
management, provenance, testing, and incident/audit requirements. It does not
itself define the Recall/Meridian architecture, but it strongly supports the
decision to make lifecycle, provenance, verification, and audit core substrate.

## Open Questions

- Should Recall/Meridian explicitly model NIST's govern/map/measure/manage as
  internal phase tags or only use them as planning vocabulary?
- What minimum publication policy is enough for Meridian network mode?
- What incident disclosure means in local Recall mode versus public Meridian
  network mode needs definition.
- Which risks should block publication versus only require warning or
  diagnostic review?
- Should feature publication require a local validation threshold such as
  successful runs, tests, or human review?

## Build Decision Candidate

Adopt NIST lifecycle risk framing as a rebuild control:

```text
Every trust-changing action in Recall/Meridian must be governable, mappable,
measurable, and manageable through provenance, lifecycle state, partition,
promotion policy, and audit sediment.
```

