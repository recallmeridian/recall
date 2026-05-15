# Recall Release Scope

This document defines the first public Recall release boundary.

The rule is simple:

```text
Release the local-first Recall product surface.
Do not release private research evidence, generated artifacts, or unvalidated
project-specific strategy as product content.
```

## Release Modes

### Source-Only Limited Public

This is the current target.

It is for outsider review, local testing, bug reports, and contribution
feedback. It uses the vendored core under `lib/meridian-core`, so the public
mirror should not require a sibling private checkout.

The standard first-run walkthrough lives at `docs/setup/getting-started.md`.
It generalizes the original outsider trial packet into the default path for
any new user.

Run:

```powershell
node bin\meridian.js open-source readiness --stage limited-public --release-mode source
node bin\meridian.js open-source release-scope
```

### Npm Release

This is now a release-candidate path for the public CLI package. The package is
scoped as `@recallmeridian/recall` while the installed command names remain
`recall` and `meridian`.

Npm release requires package metadata, npm-mode readiness, package dry run, and
a clean consumer install smoke test.

Run this as the npm readiness check:

```powershell
node bin\meridian.js open-source readiness --stage limited-public --release-mode npm
npm pack --dry-run
```

## Public Feature Set

The first public Recall release should focus on:

- Welcome flow:
  - `recall welcome doctor`
  - `recall welcome discover`
  - `recall welcome plan`
  - `recall welcome organize`
  - `recall welcome review`
  - `recall welcome actions`
- History import:
  - `recall import-history scan`
  - `recall import-history project-plan`
  - `recall import-history upload-project`
  - `recall import-history analyze`
  - `recall import-history promote`
- Local knowledge base basics:
  - `recall init`
  - `recall add`
  - `recall browse`
  - `recall search`
  - `recall status`
  - `recall verify`
  - `recall export`
- Open-source readiness:
  - `recall welcome walkthrough`
  - `recall open-source readiness`
  - `recall open-source release-scope`
  - `recall open-source outsider-packet`
  - `recall open-source outsider-transcript`

This is the product promise:

```text
Recall helps users safely recover and organize project memory from local repos,
files, and AI coding sessions. Imported material starts as draft evidence and
must be reviewed before promotion.
```

The default feature seed is governed by
`docs/setup/feature-audit.md`. The open-source default bucket contains only the
features needed for setup, local KB use, draft import, feature building,
auditing, release readiness, and knowledge lifecycle controls. Advanced
Intelligence Loop, terrain, relay, research, brainstorm, and project-specific
surfaces belong in the feature bank unless separately promoted.

## Experimental But Shippable With Labels

These surfaces can exist in source-only trials if clearly labeled as local lab
features:

- Intelligence Loop scaffolding
- brainstorm/debator tooling
- agent handoff ledger
- audit-debt tooling
- knowledge terrain/action-card modules
- feature capability gates
- local dry-run helper scripts such as `scripts/geo-metadata-dry-run.js`
- architecture and vision documents under `docs/architecture/**`,
  `docs/geo-recall-meridian-*.md`, and `docs/meridian-*.md`

They should not be the headline promise of the first public release.

## Excluded By Default

Do not release these surfaces as product content:

- `data/imports/**`
- `data/research-artifacts/**`
- `data/parity/**`
- `data/local-inputs/**`
- `downloads/**`
- `docs/plans/**`
- `docs/agent-handoffs/**`
- `docs/ui-research/**`
- `.vscode/**`
- `docs/work-inbox/**`
- unrelated local project folders such as `accounting-platform/**`
- raw downloaded artifacts
- raw AI-session transcripts
- private Codex/Claude/Gemini session outputs
- private strategy and market research artifacts
- Erdos/private math source packs
- dating assistant or other personal/private project research
- generated `.codex-tmp/**`, `.recall/**`, or `.meridian/**` state

The project may release the machinery for research memory. It should not release
the private research memory itself without explicit human review.

## Whole-Repo Public Release

Do not make the whole working checkout public while excluded surfaces remain in
the repository.

Use one of these release paths:

- a release/export branch containing only public and intentionally experimental
  surfaces
- a source-only archive assembled from an allowlist
- a cleaned repository after excluded research/private material is moved out

Check the current classification with:

```powershell
node bin\meridian.js open-source release-scope --json
```

Materialize the allowlist into a separate public mirror directory with:

```powershell
node bin\meridian.js open-source export-scope --output-dir ..\recall-public-mirror --dry-run
node bin\meridian.js open-source export-scope --output-dir ..\recall-public-mirror
```

By default this copies public plus intentionally experimental surfaces and writes
`release-scope-export.json` in the mirror. Use `--public-only` when you want the
smallest kernel/surface/demo export without experimental lab tooling.

For the repeatable release path, prefer the wrapper script:

```powershell
npm run release:mirror -- --output-dir ..\recall-public-mirror
```

The wrapper requires a fresh output directory, runs the targeted release-scope
and readiness tests, runs limited-public npm readiness, checks release scope,
then exports the mirror. Use `--json` for automation logs and `--public-only`
for the smallest safe mirror.

The GitLab CI gate runs the same release-facing checks on each push:

```text
npm ci
npm test -- --runInBand
node bin/meridian.js open-source readiness --stage limited-public --release-mode npm
npm pack --dry-run
npm run release:mirror -- --output-dir <ci-public-mirror> --json
```

To prove that the current checkout is safe as a whole public repo, run:

```powershell
node bin\meridian.js open-source release-scope --require-whole-repo-public
```

That command should block until excluded surfaces have been removed or moved out
of the public repository.

## Release Gates

Before a broader public release:

- source-only readiness passes
- release-scope report has no unresolved public-surface blockers
- outsider trial transcript passes
- welcome flow works for a real outside project
- private paths and secrets are scanned
- npm mode passes readiness, package dry run, and clean consumer smoke tests
- excluded research/private surfaces are absent from the public release branch
- README, setup docs, security policy, and contribution guide match the actual
  release mode
