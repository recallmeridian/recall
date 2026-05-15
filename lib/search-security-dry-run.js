'use strict';

const { buildRetrievalContext } = require('./retrieval-partition-policy');
const {
  buildRetrievalReconsolidationBatch,
  consumeRetrievalReconsolidationCandidates,
} = require('./retrieval-reconsolidation');

function summarizeSecurityDryRun(entries, queryContext = {}) {
  const result = buildRetrievalContext(entries, queryContext);
  const reconsolidation = buildRetrievalReconsolidationBatch({
    allowed: result.candidates,
    denied: result.denied,
    queryContext,
    generatedAt: queryContext.now,
    retrievalId: queryContext.retrievalId,
  });

  return {
    retrievalMode: queryContext.from || queryContext.retrievalMode || 'normal',
    allowed: result.candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name || candidate.title || '',
      partition: candidate.partition,
      source_trust_level: candidate.source_trust_level,
      contextTreatment: candidate.partition === 'trusted_kb' && candidate.source_trust_level === 'trusted'
        ? 'trusted_raw'
        : 'spotlighted_untrusted_data',
    })),
    denied: result.denied.map((item) => ({
      id: item.candidate.id,
      name: item.candidate.name || item.candidate.title || '',
      partition: item.candidate.partition,
      source_trust_level: item.candidate.source_trust_level,
      reasons: item.reasons,
    })),
    auditEvents: result.auditEvents,
    contextItems: result.contextItems,
    reconsolidation,
    reconsolidationSummary: consumeRetrievalReconsolidationCandidates(reconsolidation.events),
  };
}

function formatSecurityDryRun(summary) {
  const lines = [];
  lines.push(`Security dry run (${summary.retrievalMode})`);
  lines.push('');
  lines.push('Allowed:');
  if (summary.allowed.length === 0) {
    lines.push('  - none');
  } else {
    for (const item of summary.allowed) {
      lines.push(`  - ${item.id} [${item.partition}/${item.source_trust_level}] -> ${item.contextTreatment}`);
    }
  }

  lines.push('');
  lines.push('Denied:');
  if (summary.denied.length === 0) {
    lines.push('  - none');
  } else {
    for (const item of summary.denied) {
      lines.push(`  - ${item.id} [${item.partition}/${item.source_trust_level}] -> ${item.reasons.join(', ')}`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  formatSecurityDryRun,
  summarizeSecurityDryRun,
};
