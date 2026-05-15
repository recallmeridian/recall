# Recall/Meridian Agent Rules

## Local-Only Working Rule

Do not use OneDrive-backed paths as build-critical source of truth.

Before using any file as build input, dependency input, audit input, research
input, or automation input, check whether the path routes through OneDrive. If
it does, copy the needed file into a local non-OneDrive workspace and rewrite
active references to the local path before continuing.

Use local workspace paths such as:

- `%USERPROFILE%\Desktop\recall-cli`
- `%USERPROFILE%\Desktop\recall-commons`

Avoid:

- `%USERPROFILE%\OneDrive\...`
- home-directory OneDrive folders on any platform

OneDrive may be used only as historical evidence in old notes, never as the
active checkout, active dependency path, shell profile dependency, Git working
tree, or automation root.

If a command output, config file, prompt, doc, or script points to OneDrive for
active work, treat that as a blocker and localize it first.

## Downloads Rule

Do not use `downloads/` as build-critical source of truth.

If downloaded research artifacts are needed after ingestion, copy them into a
local repo-owned artifact cache such as `data/research-artifacts/<import-set>/`
and rewrite active manifests to that local path.

Do not commit raw downloaded artifacts by default. Keep artifact caches local
and commit only manifests, citations, extraction notes, and build cards unless
the user explicitly asks to archive raw artifacts in Git.

## Local Tooling Rule

Prefer local non-OneDrive tools before bundled app or app-store command aliases.

The canonical local tool bin is:

- `%USERPROFILE%\Desktop\tools\bin`

This folder must appear before bundled app command aliases in PATH. In automation or Codex
shell calls, use PowerShell `-NoProfile`/`login:false` when possible so commands
do not wait on OneDrive-backed PowerShell profiles. If `rg`, Codex CLI, Claude
CLI, Node, Git, or test commands resolve through OneDrive, Downloads, PowerShell
script shims, or app-store aliases when a local tool exists, treat that as a
tooling bug and prefer the local path.

Current local tool expectations:

```powershell
where.exe rg
rg --version
```

The first `rg` result should be either the local binary or the temporary npm
shim that forwards to it:

```text
%USERPROFILE%\Desktop\tools\bin\rg.exe
%APPDATA%\npm\rg.cmd
```

## Git Hygiene

Stage scoped slices only. This repository often has parallel local work in
progress, so do not use broad `git add .` unless the user explicitly requests a
bulk commit.

## Agent Handoff Ledger Rule

For meaningful Recall/Meridian or Polymarket agent work, create an agent
handoff record before ending the session or handing work to another agent.

Use one of the current role IDs:

- `research-cartographer`
- `implementation-builder`
- `adversarial-reviewer`

Record the role that actually matched the work, why it was selected, evidence
refs, expected outputs, actual outputs, files touched, commands/tests run,
outcome, and any draft lessons.

Validate and record with:

```powershell
node bin\meridian.js intelligence agent-handoff-check <handoff.json>
node bin\meridian.js intelligence agent-handoff <handoff.json>
```

For blocked, failed, or uncertain work, include `failureSignals`. Do not
promote draft lessons automatically; hard-case lessons require later
validation, review, or benchmark evidence.

## Intelligence Loop Decision Rule

For tough Recall/Meridian decisions, use the full Intelligence Loop as the
outer workflow. The brainstorm/debator feature is a decision tool inside the
Intelligence Loop, not a replacement for it.

Use this sequence when a task affects architecture, safety, retrieval,
promotion, feature capability, open-source readiness, or durable project
knowledge:

1. Run an IL preflight or cycle preflight for the topic.
2. If there are multiple viable paths, run the brainstorm/debator preflight
   with 2-3 options and evidence refs.
3. Treat debate output as draft local evidence until repo tests, evaluator
   results, verifier evidence, human review, or observed outcomes validate it.
4. Implement the selected scoped slice.
5. Run targeted tests and the relevant full-suite check.
6. Record the agent handoff.
7. Run/store the post-build IL cycle and record outcome follow-ups.

Do not use debator consensus alone as a project decision. If IL finds weak or
missing evidence, either gather evidence, create a research gap, or run a
focused implementation spike with clear validation.
