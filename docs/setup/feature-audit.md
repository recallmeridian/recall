# Recall Feature Audit

Date: 2026-05-09

Purpose: decide which features belong in the open-source default Recall
experience, and which should live in a separate feature bank.

The open-source default should include only features that make Recall easier to
install, understand, use, audit, and extend as a local-first knowledge and
feature platform.

Project-specific features for Jesse's private projects should not ship as
default open-source features. They can become private incubator work or later
paid/partner feature-bank packs after separate review.

## Audit Rules

### Bucket 1 - Open-Source Default

Include a feature by default only when it directly improves general Recall:

- first-run setup and onboarding
- local knowledge base basics
- draft import and review
- feature registry, feature-builder, approvals, and local run ledgers
- release readiness and public mirror tooling
- local audit debt and knowledge lifecycle controls
- core example features that explain Recall itself

### Bucket 2 - Feature Bank

Keep a feature out of the default package when it is useful but not required for
the first public Recall experience:

- advanced Intelligence Loop, evaluator, verifier, benchmark, or agent-routing
  machinery
- brainstorm/debate tooling
- terrain visualization and diagnostic projections
- research-workflow tooling that is more lab/internal than first-run product
- managed relay/service packaging until the service contract is ready
- network push/pull/publication surfaces
- embedding/UI surfaces that need extra dependencies, keys, or polish
- domain/project-specific packs such as finance, dating, Erdos,
  customer workspace, or other private customer/project work

## Current Catalog Snapshot

The generated core catalog currently contains 146 feature manifests.

Group counts:

| Group | Count | Initial Bucket |
| --- | ---: | --- |
| `welcome` | 9 | Open-source default |
| `import-history` | 7 | Open-source default |
| `recall` | 16 | Mixed |
| `feature` | 46 | Mixed |
| `open-source` | 6 | Open-source default |
| `audit-debt` | 4 | Open-source default |
| `knowledge` | 5 | Open-source default |
| `release` | 1 | Open-source default |
| `relay` | 7 | Feature bank |
| `research` | 9 | Feature bank |
| `brainstorm` | 3 | Feature bank |
| `intelligence` | 33 | Feature bank |

No seeded default feature IDs currently appear to be explicitly finance,
dating, Erdos, or customer-workspace specific. Those project surfaces are
present elsewhere in the working repo as data, scripts, or plans, and should
remain outside the default feature seed and public package surface.

## Bucket 1 - Open-Source Default Features

These should ship as the default Recall feature set.

### First-Run And Onboarding

- `welcome-actions`
- `welcome-discover`
- `welcome-doctor`
- `welcome-organize`
- `welcome-organize-apply`
- `welcome-organize-check`
- `welcome-plan`
- `welcome-review`
- `welcome-walkthrough`

Reason: these make Recall understandable and usable for a new person without
private context.

### Draft Import And Review

- `import-history-analyze`
- `import-history-import`
- `import-history-project-plan`
- `import-history-promote`
- `import-history-scan`
- `import-history-upload-project`
- `import-history-upload-projects`

Reason: draft-only project memory import is a core Recall value proposition.

### Local KB Basics

- `recall-add`
- `recall-browse`
- `recall-config`
- `recall-export`
- `recall-ingest`
- `recall-init`
- `recall-query`
- `recall-search`
- `recall-status`
- `recall-ui`
- `recall-verify`

Reason: these are the basic local knowledge base operations.

### Core Recall Examples And App Integration Contract

- `recall-app-port`
- `recall-project-health-brief`
- `knowledge-terrain-atlas`

Reason: these demonstrate Recall's core direction: safe app access, project
health summaries, and diagnostic knowledge maps. Keep `knowledge-terrain-atlas`
as an example/diagnostic surface, not as a default truth engine.

### Feature Registry And Feature Builder

- `feature-approvals`
- `feature-approve`
- `feature-build-finish-check`
- `feature-build-improve`
- `feature-build-ledger-verify`
- `feature-build-plan`
- `feature-build-status`
- `feature-deny`
- `feature-example-run`
- `feature-health`
- `feature-list`
- `feature-manifest-check`
- `feature-register`
- `feature-review`
- `feature-runs`
- `feature-seed-core-registry`
- `feature-verify-ledgers`

Reason: these make Recall able to build, finish, improve, gate, and audit
features. This is central to the product.

### Open-Source And Release Readiness

- `open-source-export-scope`
- `open-source-outsider-packet`
- `open-source-outsider-transcript`
- `open-source-outsider-trial`
- `open-source-readiness`
- `open-source-release-scope`
- `release-mirror`

Reason: these make the public release safe and auditable. The visible new-user
path should be `recall welcome walkthrough`, but the lower-level open-source
trial features remain useful release machinery.

### Audit Debt

- `audit-debt-list`
- `audit-debt-record`
- `audit-debt-scan`
- `audit-debt-verify`

Reason: audit debt is a general Recall mechanism for turning review findings
into tracked local work.

### Knowledge Lifecycle

- `knowledge-history`
- `knowledge-rollback-plan`
- `knowledge-transition`
- `knowledge-verify`

Reason: promotion, demotion, verification, history, and rollback are core
memory-governance concepts.

Default bucket count: 62.

## Bucket 2 - Feature Bank

These should not be default-on for the first open-source release. They are still
valuable. Treat them as optional packs, premium features, incubator modules, or
future enterprise/developer add-ons.

### Advanced Terrain And Memory Diagnostics

- `feature-bridge-map`
- `feature-ecosystem-health`
- `feature-reconsolidation-append`
- `feature-reconsolidation-verify`
- `feature-terrain-actions`
- `feature-terrain-actions-append`
- `feature-terrain-actions-list`
- `feature-terrain-actions-verify`
- `feature-terrain-anchor-approvals-list`
- `feature-terrain-anchor-approvals-verify`
- `feature-terrain-anchor-review`
- `feature-terrain-anchor-suggestions`
- `feature-terrain-anchors-export`
- `feature-terrain-atlas`
- `feature-terrain-diff`
- `feature-terrain-insights`
- `feature-terrain-morphology`
- `feature-terrain-relationship-approvals-list`
- `feature-terrain-relationship-approvals-verify`
- `feature-terrain-relationship-review`
- `feature-terrain-relationship-suggestions`
- `feature-terrain-relationship-validation-delta`
- `feature-terrain-relationships-export`
- `feature-terrain-render`
- `feature-terrain-review-workbench`
- `feature-terrain-snapshot`
- `feature-terrain-source-pack`
- `feature-terrain-validate`
- `feature-terrain-validation-delta`

Reason: these are powerful but too advanced for the default open-source first
run. They are strong candidates for a paid/pro/developer feature bank.

### Intelligence Loop And Agent Learning

- `intelligence-agent-handoff`
- `intelligence-agent-handoff-check`
- `intelligence-agent-handoff-list`
- `intelligence-agent-handoff-template`
- `intelligence-agent-hard-cases`
- `intelligence-agent-router-readiness`
- `intelligence-artifact-list`
- `intelligence-artifact-store`
- `intelligence-benchmark-add`
- `intelligence-benchmark-batch-run`
- `intelligence-benchmark-expand`
- `intelligence-benchmark-list`
- `intelligence-benchmark-pack-answers`
- `intelligence-benchmark-pack-install`
- `intelligence-benchmark-pack-list`
- `intelligence-benchmark-run`
- `intelligence-curriculum-plan`
- `intelligence-cycle-run`
- `intelligence-debate-check`
- `intelligence-evaluator-run`
- `intelligence-failure-mine`
- `intelligence-health`
- `intelligence-outcome-record`
- `intelligence-outcome-score`
- `intelligence-outcome-summary`
- `intelligence-preflight`
- `intelligence-preflight-decision`
- `intelligence-promotion-check`
- `intelligence-session-start`
- `intelligence-skill-list`
- `intelligence-trace-to-skill`
- `intelligence-verifier-adapters`
- `intelligence-verifier-check`

Reason: this is major long-term Recall value, but it is a complex developer
learning system. It should be offered as an optional feature bank or pro layer,
not as the default open-source surface.

### Brainstorm And Debate

- `brainstorm-auto-session`
- `brainstorm-preflight`
- `brainstorm-runner-diagnose`

Reason: useful decision support, but not required for core Recall onboarding.

### Research Workflow

- `research-init`
- `research-list`
- `research-next`
- `research-problem`
- `research-promote`
- `research-status`
- `research-step`
- `research-trace`
- `research-workflow`

Reason: general enough to become a feature pack, but too lab-shaped for the
default public user path.

### Managed Relay And Service Integration

- `relay-agent-manifest`
- `relay-configure`
- `relay-connector-url`
- `relay-doctor`
- `relay-pairing-packet`
- `relay-service-plan`
- `relay-status`

Reason: these are important for future paid/service distribution, but should
not be part of the default open-source feature bank until the service contract,
docs, and user expectations are final.

### Network, API-Key, Or Extra-Polish Surfaces

- `recall-embed`
- `recall-pull`
- `recall-push`

Reason: these involve network/API-key/publication behavior and should not be
default-open until the public trust boundary is settled.

Feature-bank bucket count: 84.

## Private Project Pack Rule

Anything with domain-specific intent should be excluded from open-source
default features unless it is rewritten as a general Recall capability.

Keep out of default:

- private finance, strategy, parity, live external-action, or market research features
- production-readiness finance workflows
- dating assistant workflows
- Erdos/math-private source packs
- Confluence/customer/private workspace migration tooling
- any feature whose source refs point at private `data/imports`,
  `data/research-artifacts`, `docs/plans`, or `docs/agent-handoffs` evidence
  instead of public Recall product code/docs

Potential future treatment:

- `feature-bank/private-finance`
- `feature-bank/equities`
- `feature-bank/research-lab`
- `feature-bank/agent-learning`
- `feature-bank/terrain-pro`
- `feature-bank/relay-service`

## Proposed Default Seed Policy

The default seed should register only Bucket 1 features.

The feature bank should be discoverable but not installed by default. A future
command could look like:

```powershell
recall feature-bank list
recall feature-bank install terrain-pro
recall feature-bank install agent-learning
```

Until that exists, keep feature-bank surfaces out of the default open-source
seed and out of first-run messaging.
