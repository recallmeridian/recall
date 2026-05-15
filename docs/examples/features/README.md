# Local Recall Feature Examples

These examples prove Recall's local feature loop without publishing anything to
Meridian.

## Feature Registry Contract

The feature registry is the first public contract for installable Recall
features. A feature is not just a command; it is a manifest plus a run history:

- `feature manifest-check` validates the feature contract.
- `feature register` writes a hash-chained registry record.
- `feature review` applies capability, partition, approval, and audit gates.
- `feature verify-ledgers` proves the registry and run ledgers were not quietly
  edited.
- `feature health` reports whether registered features, approvals, and runs are
  healthy.

That contract is deliberately local-first today. A future paid/premade feature
marketplace should extend the manifest with listing metadata, pricing/licensing
metadata, compatibility ranges, provenance, and signed package hashes. It should
not bypass the local registry. Bought features still land as local manifests and
must pass the same gates before they run.

## Recall Project Health Brief

The first example is `recall-project-health-brief`: a read-only local feature
that can summarize trusted Recall project state and feature health signals.

Run it against a throwaway local data directory:

```powershell
$env:MERIDIAN_DATA = "$PWD\.codex-tmp\feature-example-data"
node bin\meridian.js feature example-run recall-project-health-brief
```

Or run the steps manually:

```powershell
$env:MERIDIAN_DATA = "$PWD\.codex-tmp\feature-example-data"
node bin\meridian.js feature manifest-check docs\examples\features\recall-project-health-brief.manifest.json
node bin\meridian.js feature register docs\examples\features\recall-project-health-brief.manifest.json
node bin\meridian.js feature review docs\examples\features\recall-project-health-brief.request.json --manifest docs\examples\features\recall-project-health-brief.manifest.json
node bin\meridian.js feature verify-ledgers
node bin\meridian.js feature health
```

Expected shape:

- manifest validation passes
- feature registration stays local
- feature review is `allowed`
- ledger verification passes
- feature health is `healthy`

This is the local "so what" path: a feature manifest turns trusted Recall
knowledge into a usable tool contract, while capability gates, run ledgers, and
health checks keep the tool auditable.
