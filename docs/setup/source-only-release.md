# Source-Only Limited-Public Release

This release mode is for a limited public repository trial. Npm release uses a
separate package gate.

Use it when the goal is outsider review, local testing, bug reports, and contribution feedback before broader package publication.

## What This Mode Means

- Recall remains the local experimentation and feature lab.
- The core engine needed by this CLI is vendored under `lib/meridian-core`.
- Source users need only this checkout for the public Recall CLI surface.
- npm packaging is allowed only after npm-mode readiness, package dry run, and
  clean consumer smoke tests pass.

This avoids releasing the private working instance: the repository can be
reviewed and run by trusted outsiders while userland data, handoffs, research
corpora, and generated artifacts remain outside the public mirror.

## Setup Check

From the `recall-cli` checkout:

```powershell
npm.cmd install
npm.cmd test
node bin\meridian.js open-source readiness --stage limited-public --release-mode source
node bin\meridian.js open-source release-scope
```

Before npm publication, also run the npm-mode gate:

```powershell
node bin\meridian.js open-source readiness --stage limited-public --release-mode npm
npm pack --dry-run
```

Both readiness commands should report `ready` with zero blockers before a public
package release. The release-scope command defines which files and features
belong in the public surface and which research/private artifacts must be
excluded. See `docs/setup/release-scope.md`.

To create the public mirror from the allowlist instead of exposing the whole
working checkout:

```powershell
node bin\meridian.js open-source export-scope --output-dir ..\recall-public-mirror --dry-run
node bin\meridian.js open-source export-scope --output-dir ..\recall-public-mirror
```

For a release candidate mirror, prefer the checked wrapper:

```powershell
npm run release:mirror -- --output-dir ..\recall-public-mirror
```

This requires a fresh output directory and runs the targeted mirror safety
checks before exporting.

The mirror is the source-only release artifact. The private working checkout can
keep userland data, handoffs, research corpora, and local caches out of that
artifact.

## Standard First-Run Walkthrough

The original outsider trial packet is now the standard first-run walkthrough
for any new user. See `docs/setup/getting-started.md`.

Generate a packet:

```powershell
node bin\meridian.js welcome walkthrough --participant-id first-run
```

By default this writes:

```text
.codex-tmp/
  outsider-trials/
    first-run/
      README.md
      transcript.json
      transcript-answers.md
```

The packet README contains the exact commands the new user should run next. The
short version is:

```powershell
node bin\meridian.js open-source outsider-trial --execute --output .codex-tmp\outsider-trials\first-run\mechanical-report.json --transcript-output .codex-tmp\outsider-trials\first-run\transcript.json --outsider-id first-run
node bin\meridian.js open-source outsider-transcript .codex-tmp\outsider-trials\first-run\transcript.json --mechanical-report .codex-tmp\outsider-trials\first-run\mechanical-report.json --output .codex-tmp\outsider-trials\first-run\transcript-evaluation.json --json
```

The first command proves the mechanical path. The second command evaluates the
new-user transcript after they fill it in.

A real limited-public trial still needs a transcript from someone who did not
author Recall, using the comprehension checkpoints in the packet.

Create that transcript template with:

```powershell
node bin\meridian.js open-source outsider-transcript --template --outsider-id first-run --output .codex-tmp\outsider-trials\first-run\transcript.json
```

After the outsider answers in their own words, evaluate the transcript against the mechanical report:

```powershell
node bin\meridian.js open-source outsider-transcript .codex-tmp\outsider-trials\first-run\transcript.json --mechanical-report .codex-tmp\outsider-trials\first-run\mechanical-report.json
```

If the transcript reports confusion, treat that as readiness signal: turn it into docs, setup changes, tests, or known-risk notes before promoting readiness.

## Optional Project Import Trial

If the outsider has a local project they want Recall to understand, stage it as draft evidence:

```powershell
node bin\meridian.js import-history project-plan <path-to-project>
node bin\meridian.js import-history upload-project <path-to-project>
```

For a folder containing multiple Git repositories:

```powershell
node bin\meridian.js import-history upload-projects <path-to-projects-root> --max-depth 4
```

These commands stage project material into `recall-imports` by default. Do not use `--promote` during the outsider trial; imported project memory should stay draft until the user reviews the reconstruction.

## Exit Criteria for npm Mode

Move from source-only to npm release only after:

- A clean consumer install can import the package without sibling local paths.
- Semver, license, README, and changelog expectations are clear.
- A package dry run proves the published files are enough.
- A clean tarball install exposes `recall` and `meridian`.
- The open-source readiness gate passes with `--release-mode npm`.
