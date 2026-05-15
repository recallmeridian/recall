# Contributing to Recall/Meridian

Recall is currently a local experimentation lab for turning observations into tested, reusable knowledge and small user-facing features. Meridian is the broader publication/protocol direction, but the first contribution path is local Recall work.

The project is not open because it is finished. It becomes open when outside use is a net-positive learning signal: `External Input Gain > External Damage Risk`.

## Contribution Boundaries

Good early contributions:

- Documentation that helps a new user run the first useful workflow.
- Tests that capture a real failure, unsafe flow, or confusing behavior.
- Small fixes to local Recall CLI workflows.
- Security fixtures for prompt injection, output handling, path safety, retrieval partitioning, and capability gates.
- Research manifests and synthesis notes with clear provenance.

Avoid early contributions that:

- Treat draft knowledge as production truth.
- Promote rules or lessons without evidence.
- Add network publication, p2p, CRDT, or global Meridian behavior without an accepted design card.
- Add build-critical references to OneDrive, Downloads, private absolute paths, or local machine paths.
- Include secrets, customer data, personal records, private keys, tokens, or raw chat exports.

## Knowledge Lifecycle Rules

External or user-generated knowledge must start as draft, untrusted, or quarantined. Promotion is a separate step and requires evidence.

Before a contribution can affect durable behavior, it needs:

- Provenance: where it came from and who/what produced it.
- Evidence: tests, fixtures, audit output, research citations, or observed results.
- Review boundary: human approval for durable rules, promotions, exports, and sensitive actions.
- Recoverability: a way to demote, archive, or roll back if the contribution proves wrong.

Promotion should be harder than creation. Demotion should be easier than promotion.

## Local Development

Use a local non-OneDrive checkout:

```powershell
cd <local-non-onedrive-path>\recall-cli
npm.cmd test
node bin\meridian.js open-source readiness --stage private-alpha
```

The active build should not depend on files under OneDrive or Downloads. If a needed artifact lives there, copy it into a local repo-owned input or artifact cache and update references before using it.

## Pull Request Expectations

Before proposing a change:

- Run focused tests for the touched module.
- Run `npm.cmd test` when the change affects shared behavior.
- Run `node bin\meridian.js open-source readiness --stage private-alpha` for documentation, packaging, onboarding, or path changes.
- Keep commits scoped. Do not stage unrelated dirty files.
- Include the evidence that should make a reviewer trust the change.

For security-sensitive changes, include the failure mode being addressed and the test or fixture that proves it is contained.

## Governance

Durable project rules, knowledge promotion policies, Meridian publication behavior, security boundaries, and release readiness gates require maintainer approval. Agent debate or consensus is useful draft evidence, not authority by itself.
