'use strict';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function hasAnyTag(entry, patterns) {
  const tags = asArray(entry.tags).map((tag) => String(tag).toLowerCase());
  return patterns.some((pattern) => tags.some((tag) => pattern.test(tag)));
}

function existingPartition(entry) {
  const ext = entry._extensions || {};
  return entry.partition || ext.partition || '';
}

function existingTrust(entry) {
  const ext = entry._extensions || {};
  return entry.source_trust_level || entry.sourceTrustLevel || ext.source_trust_level || '';
}

function suggestedPartition(entry) {
  const category = String(entry.category || '').toLowerCase();
  const status = String(entry.status || '').toLowerCase();
  const ext = entry._extensions || {};
  const projectId = String(entry.projectId || entry.project_id || '').toLowerCase();

  if (existingPartition(entry)) return existingPartition(entry);
  if (category.includes('secret') || category.includes('private') || category.includes('sensitive')) return 'sensitive_vault';
  if (status === 'draft') return 'candidate_basin';
  if (category.includes('incident')) return 'candidate_basin';
  if (hasAnyTag(entry, [/known-bypass/, /hostile/])) return 'candidate_basin';
  if (hasAnyTag(entry, [/prompt-injection-fixture/]) && !category.includes('security')) return 'candidate_basin';
  if (
    ext.researchType ||
    ext.importSet ||
    projectId === 'research' ||
    category.includes('security') ||
    category.includes('research') ||
    category.includes('implementation-pattern')
  ) {
    return 'trusted_kb';
  }
  return status === 'active' ? 'trusted_kb' : 'candidate_basin';
}

function suggestedTrust(entry, partition = suggestedPartition(entry)) {
  const category = String(entry.category || '').toLowerCase();
  const source = String(entry.source || '').toLowerCase();
  const ext = entry._extensions || {};

  if (existingTrust(entry)) return existingTrust(entry);
  if (partition === 'sensitive_vault') return 'private';
  if (partition === 'quarantine_basin') return 'untrusted';
  if (partition === 'candidate_basin') return 'external_low';
  if (ext.researchType || category.includes('security') || source.includes('owasp') || source.includes('nist') || source.includes('arxiv')) {
    return 'trusted';
  }
  return 'trusted';
}

function suggestedAllowedModes(partition) {
  if (partition === 'trusted_kb') return ['normal', '*'];
  if (partition === 'candidate_basin') return ['candidate'];
  if (partition === 'quarantine_basin') return ['quarantine'];
  return [];
}

function staleArtifactPaths(entry) {
  const ext = entry._extensions || {};
  return asArray(ext.artifacts)
    .map((artifact) => artifact && artifact.path)
    .filter((artifactPath) => typeof artifactPath === 'string' && /^downloads[\\/]/i.test(artifactPath));
}

function localizedArtifactPath(artifactPath) {
  return String(artifactPath).replace(/^downloads[\\/]research[\\/]/i, 'data/research-artifacts/');
}

function analyzeEntryGeoMetadata(entry) {
  const partition = suggestedPartition(entry);
  const sourceTrustLevel = suggestedTrust(entry, partition);
  const allowedRetrievalModes = suggestedAllowedModes(partition);
  const missing = [];
  const changes = {};

  if (!existingPartition(entry)) {
    missing.push('partition');
    changes.partition = partition;
  }
  if (!existingTrust(entry)) {
    missing.push('source_trust_level');
    changes.source_trust_level = sourceTrustLevel;
  }
  if (!entry.allowed_retrieval_modes && !(entry._extensions && entry._extensions.allowed_retrieval_modes)) {
    missing.push('allowed_retrieval_modes');
    changes.allowed_retrieval_modes = allowedRetrievalModes;
  }

  const stalePaths = staleArtifactPaths(entry);
  if (stalePaths.length > 0) {
    missing.push('localized_artifact_paths');
    changes.localized_artifact_paths = stalePaths.map((artifactPath) => ({
      from: artifactPath,
      to: localizedArtifactPath(artifactPath),
    }));
  }

  return {
    entryId: entry.id || entry.entry_id || '',
    projectId: entry.projectId || entry.project_id || '',
    name: entry.name || entry.title || '',
    current: {
      partition: existingPartition(entry) || null,
      source_trust_level: existingTrust(entry) || null,
      allowed_retrieval_modes: entry.allowed_retrieval_modes || (entry._extensions && entry._extensions.allowed_retrieval_modes) || null,
    },
    suggested: {
      partition,
      source_trust_level: sourceTrustLevel,
      allowed_retrieval_modes: allowedRetrievalModes,
    },
    missing,
    changes,
    needsUpdate: missing.length > 0,
  };
}

function applyEntryGeoMetadata(entry) {
  const analysis = analyzeEntryGeoMetadata(entry);
  if (!analysis.needsUpdate) {
    return {
      entry,
      analysis,
      changed: false,
    };
  }

  const next = {
    ...entry,
  };

  if (analysis.changes.partition !== undefined) next.partition = analysis.changes.partition;
  if (analysis.changes.source_trust_level !== undefined) next.source_trust_level = analysis.changes.source_trust_level;
  if (analysis.changes.allowed_retrieval_modes !== undefined) {
    next.allowed_retrieval_modes = analysis.changes.allowed_retrieval_modes.slice();
  }

  if (analysis.changes.localized_artifact_paths) {
    const pathMap = new Map(
      analysis.changes.localized_artifact_paths.map((item) => [item.from, item.to])
    );
    const ext = next._extensions || {};
    next._extensions = {
      ...ext,
      artifacts: asArray(ext.artifacts).map((artifact) => {
        if (!artifact || typeof artifact.path !== 'string') return artifact;
        if (!pathMap.has(artifact.path)) return artifact;
        return {
          ...artifact,
          path: pathMap.get(artifact.path),
        };
      }),
    };
  }

  return {
    entry: next,
    analysis,
    changed: true,
  };
}

function applyGeoMetadata(entries) {
  const results = asArray(entries).map(applyEntryGeoMetadata);
  return {
    entries: results.map((result) => result.entry),
    analyses: results.map((result) => result.analysis),
    changed: results.filter((result) => result.changed).length,
  };
}

function summarizeGeoMetadata(entries) {
  const analyses = asArray(entries).map(analyzeEntryGeoMetadata);
  const needsUpdate = analyses.filter((entry) => entry.needsUpdate);
  const byPartition = analyses.reduce((acc, entry) => {
    acc[entry.suggested.partition] = (acc[entry.suggested.partition] || 0) + 1;
    return acc;
  }, {});

  return {
    total: analyses.length,
    needsUpdate: needsUpdate.length,
    byPartition,
    entries: analyses,
  };
}

module.exports = {
  analyzeEntryGeoMetadata,
  applyEntryGeoMetadata,
  applyGeoMetadata,
  localizedArtifactPath,
  summarizeGeoMetadata,
};
