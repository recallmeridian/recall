# Recall Dashboard

Recall's dashboard is a static, read-only visual index over the local workspace.
It is an inbound adapter in the hexagonal architecture: it reads existing KB
state, feature ledgers, research manifests, and documentation, then writes an
HTML page. It does not become a source of truth.

Generate the default dashboard:

```powershell
node bin\meridian.js ui dashboard
```

By default this writes:

```text
<MERIDIAN_DATA>\dashboard.html
```

Use a custom output path:

```powershell
node bin\meridian.js ui dashboard --output .codex-tmp\dashboard\recall-dashboard.html
```

The page is organized like a lightweight Confluence home page:

- Hexagonal architecture: core, inbound adapters, outbound adapters, and the
  read-only dashboard rule.
- Workspace areas: Recall/Meridian, private strategy, private finance, and the research
  column.
- Feature registry: feature count, risk mix, lifecycle mix, and sample
  registered features.
- Research column: counts and quick links for setup, architecture, security,
  plans, imports, and handoffs.

Regenerate after running ingest scripts, seeding the feature registry, or adding
new docs. Since it is static, the dashboard only reflects the workspace at the
moment it was generated.
