# Recall Getting Started Walkthrough

This is the standard first-run path for anyone trying Recall for the first
time. It is based on the original outsider trial packet, but it is no longer
specific to any one user.

The goal is simple: prove that Recall runs locally, show the first useful
workflow, and give the user a place to record confusion so setup feedback turns
into better docs, tests, or product changes.

## Install

### Npm Install

```powershell
npm install -g @recallmeridian/recall
recall --help
```

The package installs both command names:

```powershell
recall --help
meridian --help
```

### Source Checkout

```powershell
git clone https://gitlab.com/jesseneff/recall-public.git
cd recall-public
npm install
node bin\meridian.js --help
```

## Step 1 - Check The Local Setup

For an npm install:

```powershell
recall welcome doctor
```

For a source checkout:

```powershell
node bin\meridian.js welcome doctor
```

This checks the local environment before Recall imports or stages project
memory.

## Step 2 - Run The First Useful Workflow

Use a throwaway local data directory so the first run is isolated.

For an npm install:

```powershell
$env:MERIDIAN_DATA = "$PWD\.recall-first-run"
recall feature example-run recall-project-health-brief
```

For a source checkout:

```powershell
$env:MERIDIAN_DATA = "$PWD\.codex-tmp\feature-example-data"
node bin\meridian.js feature example-run recall-project-health-brief
```

The passing signal is that the feature manifest validates, the capability
review is allowed, ledgers verify, and feature health reports healthy.

## Step 3 - Generate A Walkthrough Packet

The walkthrough packet gives new users the same guided flow used by the first
trial. It includes a mechanical run, comprehension prompts, and an evaluation
command.

For an npm install:

```powershell
recall welcome walkthrough --participant-id first-run
```

For a source checkout:

```powershell
node bin\meridian.js welcome walkthrough --participant-id first-run
```

The command writes a packet under:

```text
.codex-tmp\outsider-trials\first-run\
```

Open the packet README and follow the commands inside it.

## Step 4 - Optional Project Import

After the first workflow passes, a user can let Recall inspect a local project
as draft evidence.

```powershell
recall import-history project-plan <path-to-project>
recall import-history upload-project <path-to-project>
```

For a folder containing several Git repositories:

```powershell
recall import-history upload-projects <path-to-projects-root> --max-depth 4
```

Do not use `--promote` on a first run. Imported material should stay draft until
the user reviews what Recall reconstructed.

## Step 5 - Record Confusion

If anything fails or feels unclear, keep the transcript answers honest. Do not
mark a checkpoint understood unless it genuinely made sense.

Good first-run feedback includes:

- the exact command that failed
- what the user expected to happen
- what actually happened
- which README or setup step was confusing
- what would have made the next action obvious

Confusion is useful evidence. It should become an issue, test, README patch, or
readiness finding.
