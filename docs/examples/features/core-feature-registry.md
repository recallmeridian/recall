# Core Feature Registry

Recall's feature registry is local runtime state, not Jesse's private Recall
data. The public project should ship the contracts, example manifests, and seed
rules that let each operator populate their own local registry.

During the May 8, 2026 consolidation sprint, the repo-local registry was seeded
from the built CLI capability surface and curated example manifests. Clean
checkouts can reproduce that seed with:

```powershell
$env:MERIDIAN_DATA = "$PWD\.meridian"
node bin\meridian.js feature seed-core-registry
node bin\meridian.js feature health
node bin\meridian.js feature verify-ledgers
```

The seed is idempotent: if the latest registered manifest for a feature already
matches the core catalog, it is reported as `unchanged` rather than appended
again.

The core seed includes:

- root Recall CLI features
- research workflow features
- history import features
- welcome/onboarding features
- brainstorm/debator features
- audit-debt features
- intelligence-loop features
- feature registry, terrain, reconsolidation, and builder features
- knowledge lifecycle features
- open-source readiness features
- managed relay features

The active repo-local registry verified with:

```powershell
$env:MERIDIAN_DATA = "$PWD\.meridian"
node bin\meridian.js feature list --json
node bin\meridian.js feature health --json
node bin\meridian.js feature verify-ledgers --json
```

Expected current shape after seeding:

- `registered_features`: 144
- `invalid_manifests`: 0
- `manifest_warnings`: 0
- registry ledger verification: `ok`

For the future paid/premade feature marketplace, the registry remains the local
authority. Marketplace purchases should install signed manifests and packages
that then register locally. They should not bypass local capability gates,
approval rules, partition checks, or ledger verification.
