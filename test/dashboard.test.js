'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildDashboardModel, renderDashboardHtml, writeDashboard } = require('../lib/dashboard');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recall-dashboard-'));
}

function writeFile(root, relativePath, text) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

describe('Recall dashboard generator', () => {
  let root;
  let dataDir;

  beforeEach(() => {
    root = tempDir();
    dataDir = path.join(root, '.meridian');
    writeFile(root, 'docs/plans/2026-05-04-private-strategy-roadmap.md', '# Private Strategy');
    writeFile(root, 'docs/plans/2026-05-08-equities-sample-research.md', '# Equities');
    writeFile(root, 'docs/architecture/public-boundary.md', '# Public Boundary');
    writeFile(root, 'docs/security/owasp-coverage.md', '# Security');
    writeFile(root, 'docs/setup/getting-started.md', '# Getting Started');
    writeFile(root, 'docs/agent-handoffs/example.json', '{}');
    writeFile(root, 'data/imports/private-strategy-research.json', '{"entries":[]}');
    writeFile(root, 'data/imports/equities-research.json', '{"entries":[]}');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('builds a Confluence-style model without requiring initialized KB data', () => {
    const model = buildDashboardModel({ root, dataDir });
    expect(model.kb.initialized).toBe(false);
    expect(model.repo.counts.plans).toBe(2);
    expect(model.repo.counts.imports).toBe(2);
    expect(model.repo.projectAreas.find((area) => area.label === 'Private Strategy').plans).toBe(1);
    expect(model.repo.projectAreas.find((area) => area.label === 'Private Finance').imports).toBe(1);
    expect(model.hex.rule).toContain('read-only adapter');
  });

  test('renders dashboard HTML with hexagonal architecture and project areas', () => {
    const html = renderDashboardHtml(buildDashboardModel({ root, dataDir }));
    expect(html).toContain('System Dashboard');
    expect(html).toContain('Hexagonal Architecture');
    expect(html).toContain('Inbound Adapters');
    expect(html).toContain('Outbound Adapters');
    expect(html).toContain('Private Strategy');
    expect(html).toContain('Private Finance');
    expect(html).toContain('Feature Registry');
    expect(html).toContain('Research Column');
  });

  test('writes a static dashboard html file', () => {
    const outputPath = path.join(root, '.meridian', 'dashboard.html');
    const result = writeDashboard({ root, dataDir, outputPath });
    expect(result.outputPath).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
    const html = fs.readFileSync(outputPath, 'utf8');
    expect(html).toContain('Generated');
    expect(html).toContain('docs/setup/getting-started.md');
  });
});
