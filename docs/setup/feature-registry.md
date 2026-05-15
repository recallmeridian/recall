# Feature Registry

The feature registry is Recall's local contract ledger for built capabilities.
It is not a marketplace yet, and it is not Jesse's private Recall data. It is
the mechanism that lets Recall say:

- what a feature is allowed to do
- which partitions it may read or write
- whether human approval is required
- how it was validated
- whether it is local-only or a candidate for later publication

## Seed The Built Features

Fresh user data starts with an empty registry. Seed the built Recall catalog:

```powershell
node bin\meridian.js feature seed-core-registry
```

Then verify it:

```powershell
node bin\meridian.js feature list
node bin\meridian.js feature health
node bin\meridian.js feature verify-ledgers
```

The current built catalog contains CLI, research, import, welcome, brainstorm,
audit-debt, intelligence-loop, feature, knowledge, open-source, and relay
features. Seeding is idempotent: running it again leaves unchanged manifests
alone unless `--force` is supplied.

## Local Registry vs Premade Feature Market

The local registry is the foundation for a future premade feature market.
Someone can eventually buy or install a premade feature, but Recall should still
treat it as a manifest first, not trusted code first.

The intended flow is:

1. A feature author ships a manifest plus implementation package.
2. Recall validates the manifest locally.
3. The user reviews the requested capabilities, partitions, approval rules, and
   denied actions.
4. Recall records the install or rejection in the local registry ledger.
5. Feature runs append to the run ledger and can be verified later.

This keeps the income path aligned with the safety model. Paid features should
earn trust through the same registry, review, approval, and ledger machinery as
core features.

## Publishable Features

Built-in local features are currently registered as:

```text
runtime_mode: recall-local
local_only: true
publishable: false
lifecycle_state: local_validated
```

Marketplace candidates should move through a stricter shape:

```text
lifecycle_state: publish_candidate
local_only: false
publishable: true
validation_method: <specific tests, evaluator, or external review evidence>
```

Published network features must not skip capability review. If a manifest asks
for write access, shell execution, raw database access, secrets, or network
publication, that must be visible before install and gated before run.

## Boundary Rule

Recall can open-source the kernel, official surfaces, and safe demo features.
It should not open-source a user's private feature registry as product source.
Local registries live under the user's Meridian data directory and are treated
as userland evidence.
