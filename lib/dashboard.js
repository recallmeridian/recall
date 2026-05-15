'use strict';

const fs = require('fs');
const path = require('path');
const cliConfig = require('./cli-config');
const meridian = require('./meridian-core');
const { listFeatureManifests, verifyFeatureRegistryChain } = require('./feature-registry');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function exists(filePath) {
  return fs.existsSync(filePath);
}

function listFiles(root, predicate) {
  if (!exists(root)) return [];
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['.git', 'node_modules', '.meridian', '.recall', '.codex-tmp'].includes(entry.name)) continue;
        walk(fullPath);
      } else if (!predicate || predicate(fullPath)) {
        files.push(fullPath);
      }
    }
  }
  walk(root);
  return files;
}

function relative(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function loadKbSummary(dataDir) {
  const configPath = path.join(dataDir, 'kb', 'config.json');
  if (!exists(configPath)) {
    return {
      initialized: false,
      projects: [],
      stats: { nodeCount: 0, edgeCount: 0, contradictionCount: 0 },
      warnings: ['Meridian data directory is not initialized yet. Run recall init or node bin/meridian.js init.'],
    };
  }

  let kb;
  try {
    kb = meridian.init(dataDir);
    return {
      initialized: true,
      projects: kb.listProjects(),
      stats: kb.getStats(),
      warnings: [],
    };
  } catch (err) {
    return {
      initialized: false,
      projects: [],
      stats: { nodeCount: 0, edgeCount: 0, contradictionCount: 0 },
      warnings: [`Could not open Meridian data directory: ${err.message}`],
    };
  } finally {
    if (kb) kb.close();
  }
}

function loadFeatureSummary(dataDir, project = 'recall-local') {
  const featureDir = path.join(dataDir, 'feature-runs', project);
  const registryPath = path.join(featureDir, 'feature-registry.jsonl');
  const runPath = path.join(featureDir, 'feature-runs.jsonl');
  const approvalPath = path.join(featureDir, 'approval-queue.jsonl');
  const auditPath = path.join(featureDir, 'audit-sediment.jsonl');
  const features = listFeatureManifests(registryPath);
  const registry = verifyFeatureRegistryChain(registryPath);
  return {
    project,
    featureDir,
    registryPath,
    count: features.length,
    registryOk: registry.ok,
    registryHead: registry.headHash,
    riskCounts: countBy(features, (item) => item.manifest.risk_level || 'unknown'),
    lifecycleCounts: countBy(features, (item) => item.manifest.lifecycle_state || 'unknown'),
    runCount: countLines(runPath),
    approvalCount: countLines(approvalPath),
    auditCount: countLines(auditPath),
    sample: features.slice(0, 8).map((item) => ({
      id: item.feature_id,
      name: item.manifest.name || item.feature_id,
      risk: item.manifest.risk_level || 'unknown',
      lifecycle: item.manifest.lifecycle_state || 'unknown',
    })),
  };
}

function countLines(filePath) {
  if (!exists(filePath)) return 0;
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter((line) => line.trim()).length;
}

function countBy(items, selector) {
  return items.reduce((acc, item) => {
    const key = selector(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function loadRepoSummary(root) {
  const docsPlans = path.join(root, 'docs', 'plans');
  const imports = path.join(root, 'data', 'imports');
  const handoffs = path.join(root, 'docs', 'agent-handoffs');
  const architecture = path.join(root, 'docs', 'architecture');
  const security = path.join(root, 'docs', 'security');
  const uiResearch = path.join(root, 'docs', 'ui-research');
  const setup = path.join(root, 'docs', 'setup');
  const confluence = path.join(root, 'confluence');

  const planFiles = listFiles(docsPlans, (file) => /\.(md|json)$/i.test(file));
  const importFiles = listFiles(imports, (file) => /\.json$/i.test(file));
  const handoffFiles = listFiles(handoffs, (file) => /\.json$/i.test(file));
  const setupFiles = listFiles(setup, (file) => /\.md$/i.test(file));
  const architectureFiles = listFiles(architecture, (file) => /\.md$/i.test(file));
  const securityFiles = listFiles(security, (file) => /\.md$/i.test(file));
  const uiFiles = listFiles(uiResearch, (file) => /\.(md|json|css)$/i.test(file));
  const confluenceFiles = listFiles(confluence);

  return {
    counts: {
      plans: planFiles.length,
      imports: importFiles.length,
      handoffs: handoffFiles.length,
      setup: setupFiles.length,
      architecture: architectureFiles.length,
      security: securityFiles.length,
      uiResearch: uiFiles.length,
      confluenceFiles: confluenceFiles.length,
    },
    projectAreas: [
      projectArea('Recall/Meridian', planFiles, importFiles, ['recall', 'meridian', 'temporal', 'terrain', 'feature']),
      projectArea('Private Strategy', planFiles, importFiles, ['private-strategy']),
      projectArea('Private Finance', planFiles, importFiles, ['private-finance', 'equities']),
      projectArea('Research Column', planFiles, importFiles, ['research', 'app-investigator', 'routing', 'security']),
    ],
    links: {
      setup: setupFiles.slice(0, 6).map((file) => relative(root, file)),
      architecture: architectureFiles.slice(0, 6).map((file) => relative(root, file)),
      security: securityFiles.slice(0, 6).map((file) => relative(root, file)),
      uiResearch: uiFiles.slice(0, 6).map((file) => relative(root, file)),
    },
  };
}

function projectArea(label, plans, imports, needles) {
  const matches = (file) => needles.some((needle) => file.toLowerCase().includes(needle));
  return {
    label,
    plans: plans.filter(matches).length,
    imports: imports.filter(matches).length,
    samplePlans: plans.filter(matches).slice(0, 4),
    sampleImports: imports.filter(matches).slice(0, 4),
  };
}

function buildDashboardModel(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const dataDir = path.resolve(options.dataDir || cliConfig.getDataDir());
  return {
    generatedAt: new Date().toISOString(),
    root,
    dataDir,
    hex: {
      core: ['Domain models', 'Temporal memory', 'Knowledge lifecycle', 'Feature manifests'],
      inbound: ['CLI', 'MCP servers', 'Static dashboard', 'Future desktop app'],
      outbound: ['Filesystem/SQLite storage', 'Parser adapters', 'Feature ledgers', 'Research manifests'],
      rule: 'Dashboard is an inbound read-only adapter. It visualizes existing ports and artifacts; it does not become a source of truth.',
    },
    kb: loadKbSummary(dataDir),
    features: loadFeatureSummary(dataDir, options.featureProject || 'recall-local'),
    repo: loadRepoSummary(root),
  };
}

function renderCountMap(map) {
  const entries = Object.entries(map || {});
  if (!entries.length) return '<li><span>none yet</span><strong>0</strong></li>';
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `<li><span>${escapeHtml(key)}</span><strong>${escapeHtml(count)}</strong></li>`)
    .join('\n');
}

function renderLinks(items) {
  if (!items.length) return '<li class="muted">No files found.</li>';
  return items.map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join('\n');
}

function renderDashboardHtml(model) {
  const projectRows = model.repo.projectAreas.map((area) => `
    <article class="area-card">
      <div>
        <p class="eyebrow">Project Area</p>
        <h3>${escapeHtml(area.label)}</h3>
      </div>
      <dl>
        <div><dt>Plans</dt><dd>${area.plans}</dd></div>
        <div><dt>Imports</dt><dd>${area.imports}</dd></div>
      </dl>
    </article>`).join('\n');

  const featureRows = model.features.sample.map((feature) => `
    <tr>
      <td>${escapeHtml(feature.name)}</td>
      <td><code>${escapeHtml(feature.id)}</code></td>
      <td>${escapeHtml(feature.risk)}</td>
      <td>${escapeHtml(feature.lifecycle)}</td>
    </tr>`).join('\n') || '<tr><td colspan="4">Run recall feature seed-core-registry to populate local features.</td></tr>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Recall System Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #172026;
      --muted: #5b6770;
      --line: #d8dee4;
      --panel: #ffffff;
      --wash: #f5f7f9;
      --accent: #0f6b68;
      --accent-2: #6e4c1e;
      --danger: #a33a2a;
      --ok: #226b3a;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--ink); background: var(--wash); }
    header { background: #102027; color: #fff; padding: 28px clamp(18px, 4vw, 48px); }
    header h1 { margin: 0; font-size: clamp(28px, 4vw, 44px); letter-spacing: 0; }
    header p { max-width: 920px; margin: 10px 0 0; color: #dbe5e8; line-height: 1.55; }
    main { padding: 24px clamp(18px, 4vw, 48px) 48px; }
    section { margin: 0 0 24px; }
    h2 { margin: 0 0 14px; font-size: 20px; letter-spacing: 0; }
    h3 { margin: 0; font-size: 17px; letter-spacing: 0; }
    .grid { display: grid; gap: 14px; }
    .metrics { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
    .areas { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    .panel, .metric, .area-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
    .metric strong { display: block; font-size: 28px; margin-top: 4px; }
    .metric span, .eyebrow, dt, .muted { color: var(--muted); }
    .eyebrow { text-transform: uppercase; font-size: 12px; font-weight: 700; margin: 0 0 5px; }
    .hex { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; }
    .hex ul, .list, .count-list { list-style: none; padding: 0; margin: 0; }
    .hex li, .list li { padding: 7px 0; border-bottom: 1px solid var(--line); }
    .hex li:last-child, .list li:last-child { border-bottom: 0; }
    .rule { border-left: 4px solid var(--accent); background: #edf6f5; }
    .area-card dl { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin: 14px 0 0; }
    .area-card div { min-width: 0; }
    dd { margin: 3px 0 0; font-size: 24px; font-weight: 800; }
    .split { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(280px, .8fr); gap: 14px; }
    @media (max-width: 850px) { .split { grid-template-columns: 1fr; } }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; }
    code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; word-break: break-word; }
    .count-list li { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--line); }
    .count-list li:last-child { border-bottom: 0; }
    .status-ok { color: var(--ok); font-weight: 800; }
    .status-warn { color: var(--danger); font-weight: 800; }
    footer { color: var(--muted); padding-top: 10px; font-size: 13px; }
  </style>
</head>
<body>
  <header>
    <p class="eyebrow">Recall Visual Index</p>
    <h1>System Dashboard</h1>
    <p>A Confluence-style front page for the local Recall workspace: where the kernel, surfaces, feature registry, research column, and project artifacts live. This page is generated from existing files and ledgers.</p>
  </header>
  <main>
    <section class="grid metrics">
      <div class="metric"><span>Data Directory</span><strong style="font-size:16px"><code>${escapeHtml(model.dataDir)}</code></strong></div>
      <div class="metric"><span>Projects</span><strong>${escapeHtml(model.kb.projects.length)}</strong></div>
      <div class="metric"><span>Entries</span><strong>${escapeHtml(model.kb.stats.nodeCount || 0)}</strong></div>
      <div class="metric"><span>Features</span><strong>${escapeHtml(model.features.count)}</strong></div>
      <div class="metric"><span>Import Manifests</span><strong>${escapeHtml(model.repo.counts.imports)}</strong></div>
    </section>

    <section>
      <h2>Hexagonal Architecture</h2>
      <div class="hex">
        <article class="panel"><p class="eyebrow">Core</p><ul>${model.hex.core.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></article>
        <article class="panel"><p class="eyebrow">Inbound Adapters</p><ul>${model.hex.inbound.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></article>
        <article class="panel"><p class="eyebrow">Outbound Adapters</p><ul>${model.hex.outbound.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></article>
        <article class="panel rule"><p class="eyebrow">Rule</p><p>${escapeHtml(model.hex.rule)}</p></article>
      </div>
    </section>

    <section>
      <h2>Workspace Areas</h2>
      <div class="grid areas">${projectRows}</div>
    </section>

    <section class="split">
      <article class="panel">
        <h2>Feature Registry</h2>
        <p>Registry chain: <span class="${model.features.registryOk ? 'status-ok' : 'status-warn'}">${model.features.registryOk ? 'verified' : 'needs review'}</span></p>
        <table>
          <thead><tr><th>Name</th><th>ID</th><th>Risk</th><th>Lifecycle</th></tr></thead>
          <tbody>${featureRows}</tbody>
        </table>
      </article>
      <aside class="panel">
        <h2>Feature Counts</h2>
        <p class="eyebrow">Risk</p>
        <ul class="count-list">${renderCountMap(model.features.riskCounts)}</ul>
        <p class="eyebrow" style="margin-top:16px">Lifecycle</p>
        <ul class="count-list">${renderCountMap(model.features.lifecycleCounts)}</ul>
      </aside>
    </section>

    <section class="split">
      <article class="panel">
        <h2>Research Column</h2>
        <ul class="count-list">
          <li><span>Plans</span><strong>${model.repo.counts.plans}</strong></li>
          <li><span>Import manifests</span><strong>${model.repo.counts.imports}</strong></li>
          <li><span>Agent handoffs</span><strong>${model.repo.counts.handoffs}</strong></li>
          <li><span>Architecture pages</span><strong>${model.repo.counts.architecture}</strong></li>
          <li><span>Security pages</span><strong>${model.repo.counts.security}</strong></li>
          <li><span>UI research pages</span><strong>${model.repo.counts.uiResearch}</strong></li>
        </ul>
      </article>
      <article class="panel">
        <h2>Quick Links</h2>
        <p class="eyebrow">Setup</p><ul class="list">${renderLinks(model.repo.links.setup)}</ul>
        <p class="eyebrow" style="margin-top:16px">Architecture</p><ul class="list">${renderLinks(model.repo.links.architecture)}</ul>
        <p class="eyebrow" style="margin-top:16px">Security</p><ul class="list">${renderLinks(model.repo.links.security)}</ul>
      </article>
    </section>

    <section class="panel">
      <h2>Open This Page Again</h2>
      <p>Regenerate with <code>recall ui dashboard</code> or <code>node bin/meridian.js ui dashboard</code>. The dashboard is static and read-only; update the KB, feature registry, or repo artifacts first, then regenerate.</p>
    </section>

    <footer>
      Generated ${escapeHtml(model.generatedAt)} from <code>${escapeHtml(model.root)}</code>.
    </footer>
  </main>
</body>
</html>`;
}

function writeDashboard(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const dataDir = path.resolve(options.dataDir || cliConfig.getDataDir());
  const outputPath = path.resolve(options.outputPath || path.join(dataDir, 'dashboard.html'));
  const model = buildDashboardModel({ ...options, root, dataDir });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, renderDashboardHtml(model), 'utf8');
  return { outputPath, model };
}

module.exports = {
  buildDashboardModel,
  escapeHtml,
  renderDashboardHtml,
  writeDashboard,
};
