'use strict';

// open-source-readiness: allow-private-path-fixtures

const {
  analyzeEntryGeoMetadata,
  applyEntryGeoMetadata,
  applyGeoMetadata,
  localizedArtifactPath,
  summarizeGeoMetadata,
} = require('../lib/geo-metadata-dry-run');
const {
  entriesFromDocument,
  formatText,
  patchDocument,
} = require('../scripts/geo-metadata-dry-run');

describe('GEO-SEC-034 geo metadata dry run', () => {
  test('suggests trusted metadata for verified research entries', () => {
    const result = analyzeEntryGeoMetadata({
      id: 'spotlighting-2024',
      projectId: 'research',
      name: 'Spotlighting paper',
      category: 'security-paper',
      status: 'active',
      source: 'arXiv / Microsoft',
      _extensions: {
        researchType: 'paper',
        importSet: 'recall-meridian-security-stack',
      },
    });

    expect(result.needsUpdate).toBe(true);
    expect(result.missing).toEqual([
      'partition',
      'source_trust_level',
      'allowed_retrieval_modes',
    ]);
    expect(result.suggested).toEqual({
      partition: 'trusted_kb',
      source_trust_level: 'trusted',
      allowed_retrieval_modes: ['normal', '*'],
    });
  });

  test('suggests candidate basin for drafts and incident fixture material', () => {
    const result = analyzeEntryGeoMetadata({
      id: 'fixture-1',
      status: 'draft',
      tags: ['prompt-injection-fixture'],
    });

    expect(result.suggested.partition).toBe('candidate_basin');
    expect(result.suggested.source_trust_level).toBe('external_low');
    expect(result.suggested.allowed_retrieval_modes).toEqual(['candidate']);

    const incident = analyzeEntryGeoMetadata({
      id: 'echoleak',
      category: 'security-incident',
      tags: ['prompt-injection-fixture'],
    });

    expect(incident.suggested.partition).toBe('candidate_basin');
  });

  test('keeps curated prompt-injection papers in trusted KB', () => {
    const result = analyzeEntryGeoMetadata({
      id: 'greshake-2023',
      category: 'security-paper',
      tags: ['prompt-injection-fixture'],
      source: 'arXiv / Black Hat USA',
    });

    expect(result.suggested.partition).toBe('trusted_kb');
    expect(result.suggested.source_trust_level).toBe('trusted');
  });

  test('keeps curated research manifests trusted even outside security categories', () => {
    const result = analyzeEntryGeoMetadata({
      id: 'cloudevents-v1-spec',
      project_id: 'research',
      category: 'audit-event-schema-standards',
      source: 'CNCF',
    });

    expect(result.suggested.partition).toBe('trusted_kb');
    expect(result.suggested.source_trust_level).toBe('trusted');
  });

  test('suggests sensitive vault for private categories', () => {
    const result = analyzeEntryGeoMetadata({
      id: 'private-1',
      category: 'private-client-record',
      status: 'active',
    });

    expect(result.suggested.partition).toBe('sensitive_vault');
    expect(result.suggested.source_trust_level).toBe('private');
    expect(result.suggested.allowed_retrieval_modes).toEqual([]);
  });

  test('does not overwrite existing explicit metadata', () => {
    const result = analyzeEntryGeoMetadata({
      id: 'existing-1',
      partition: 'quarantine_basin',
      source_trust_level: 'untrusted',
      allowed_retrieval_modes: ['quarantine'],
    });

    expect(result.needsUpdate).toBe(false);
    expect(result.changes).toEqual({});
    expect(result.suggested).toEqual({
      partition: 'quarantine_basin',
      source_trust_level: 'untrusted',
      allowed_retrieval_modes: ['quarantine'],
    });
  });

  test('applies suggested metadata without mutating the source entry', () => {
    const staleDownloadPath = ['downloads', 'research', 'batch', 'source.html'].join('/');
    const source = {
      id: 'research-1',
      category: 'security-standard',
      _extensions: {
        artifacts: [{ path: staleDownloadPath }],
      },
    };

    const result = applyEntryGeoMetadata(source);

    expect(result.changed).toBe(true);
    expect(source.partition).toBeUndefined();
    expect(source._extensions.artifacts[0].path).toBe(staleDownloadPath);
    expect(result.entry.partition).toBe('trusted_kb');
    expect(result.entry.source_trust_level).toBe('trusted');
    expect(result.entry.allowed_retrieval_modes).toEqual(['normal', '*']);
    expect(result.entry._extensions.artifacts[0].path).toBe('data/research-artifacts/batch/source.html');
  });

  test('applies metadata to a collection and counts changed entries', () => {
    const result = applyGeoMetadata([
      { id: 'missing', status: 'active' },
      {
        id: 'complete',
        partition: 'trusted_kb',
        source_trust_level: 'trusted',
        allowed_retrieval_modes: ['normal', '*'],
      },
    ]);

    expect(result.changed).toBe(1);
    expect(result.entries[0].partition).toBe('trusted_kb');
    expect(result.entries[1].partition).toBe('trusted_kb');
  });

  test('detects stale downloads artifact paths and suggests local artifact cache paths', () => {
    const staleDownloadPath = ['downloads', 'research', 'recall-security-stack', 'paper.pdf'].join('/');
    const staleWindowsDownloadPath = ['downloads', 'research', 'batch', 'file.html'].join('\\');
    const result = analyzeEntryGeoMetadata({
      id: 'research-1',
      status: 'active',
      _extensions: {
        researchType: 'paper',
        artifacts: [
          {
            path: staleDownloadPath,
          },
        ],
      },
    });

    expect(result.missing).toContain('localized_artifact_paths');
    expect(result.changes.localized_artifact_paths).toEqual([
      {
        from: staleDownloadPath,
        to: 'data/research-artifacts/recall-security-stack/paper.pdf',
      },
    ]);
    expect(localizedArtifactPath(staleWindowsDownloadPath)).toBe('data/research-artifacts/batch\\file.html');
  });

  test('summarizes update count and suggested partitions', () => {
    const summary = summarizeGeoMetadata([
      {
        id: 'trusted-1',
        status: 'active',
        _extensions: { researchType: 'paper' },
      },
      {
        id: 'private-1',
        category: 'sensitive-note',
        status: 'active',
      },
      {
        id: 'complete-1',
        partition: 'trusted_kb',
        source_trust_level: 'trusted',
        allowed_retrieval_modes: ['normal', '*'],
      },
    ]);

    expect(summary.total).toBe(3);
    expect(summary.needsUpdate).toBe(2);
    expect(summary.byPartition).toEqual({
      trusted_kb: 2,
      sensitive_vault: 1,
    });
  });

  test('normalizes manifest entries for dry-run reporting', () => {
    const entries = entriesFromDocument({
      project_id: 'research',
      entries: [
        {
          id: 'owasp-llm05',
          title: 'OWASP LLM05',
          category: 'security-standard',
          status: 'active',
        },
      ],
    });

    const summary = summarizeGeoMetadata(entries);
    expect(summary.entries[0].projectId).toBe('research');
    expect(summary.entries[0].name).toBe('OWASP LLM05');
    expect(summary.entries[0].suggested.partition).toBe('trusted_kb');
  });

  test('formats a human-readable dry-run report', () => {
    const report = formatText(
      summarizeGeoMetadata([
        {
          id: 'stale-artifact',
          status: 'active',
          _extensions: {
            artifacts: [{ path: 'downloads/research/batch/source.html' }],
          },
        },
      ]),
      'manifest.json'
    );

    expect(report).toContain('Geo metadata dry run: manifest.json');
    expect(report).toContain('needs_update=1');
    expect(report).toContain('downloads/research/batch/source.html -> data/research-artifacts/batch/source.html');
  });

  test('patches manifest documents without changing the project-level metadata', () => {
    const patched = patchDocument({
      import_set: 'security',
      project_id: 'research',
      entries: [
        {
          id: 'owasp-llm05',
          title: 'OWASP LLM05',
          category: 'security-standard',
          status: 'active',
        },
      ],
    });

    expect(patched.project_id).toBe('research');
    expect(patched.entries[0].project_id).toBeUndefined();
    expect(patched.entries[0].partition).toBe('trusted_kb');
    expect(patched.entries[0].source_trust_level).toBe('trusted');
    expect(patched.geo_metadata_dry_run).toEqual({
      changed: 1,
      generated_at: '1970-01-01T00:00:00.000Z',
      mode: 'patch-preview',
    });
  });
});
