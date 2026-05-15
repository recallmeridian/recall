'use strict';

const fs = require('fs');

const PARTITIONS = {
  TRUSTED: 'trusted_kb',
  CANDIDATE: 'candidate_basin',
  QUARANTINE: 'quarantine_basin',
  SENSITIVE: 'sensitive_vault',
  WORKING: 'working_context',
};

const DEATH_GRIP_ACTIONS = Object.freeze({
  DELETE: 'delete',
  OVERWRITE: 'overwrite',
  EXPORT: 'export',
  PUBLISH: 'publish',
  AUTH_SECURITY_CHANGE: 'auth_security_change',
  EXTERNAL_WRITE: 'external_write',
  LIVE_MODE: 'live_mode',
  CROSS_PROJECT_PROPAGATION: 'cross_project_propagation',
  PROMOTE_QUARANTINE: 'promote_quarantine',
});

const DEATH_GRIP_PATTERNS = [
  [DEATH_GRIP_ACTIONS.PROMOTE_QUARANTINE, /promote:quarantine|promote_quarantine/i],
  [DEATH_GRIP_ACTIONS.AUTH_SECURITY_CHANGE, /auth|security|permission|role|key|secret/i],
  [DEATH_GRIP_ACTIONS.CROSS_PROJECT_PROPAGATION, /cross[-_:]?project|propagat|sync:project/i],
  [DEATH_GRIP_ACTIONS.EXTERNAL_WRITE, /email:external|external.*write|connector.*write|webhook|slack|teams|gmail|outlook/i],
  [DEATH_GRIP_ACTIONS.LIVE_MODE, /live[-_:]?mode|external-action:submit|execute:live/i],
  [DEATH_GRIP_ACTIONS.DELETE, /delete|remove|destroy/i],
  [DEATH_GRIP_ACTIONS.OVERWRITE, /overwrite|replace|update:trusted|memory:write/i],
  [DEATH_GRIP_ACTIONS.EXPORT, /export|download|exfiltrate/i],
  [DEATH_GRIP_ACTIONS.PUBLISH, /publish|push|meridian/i],
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function readEntries(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (!text) return [];
  if (text.startsWith('[')) return JSON.parse(text);
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function inc(object, key, amount = 1) {
  const normalized = key || 'unknown';
  object[normalized] = (object[normalized] || 0) + amount;
}

function partitionOf(entry = {}) {
  return entry.partition
    || (entry.root_filter && entry.root_filter.partition)
    || (entry.root_filter && entry.root_filter.provenance && entry.root_filter.provenance.partition)
    || 'unknown';
}

function trustOf(entry = {}) {
  return entry.source_trust_level || entry.sourceTrustLevel || 'unknown';
}

function lifecycleOf(entry = {}) {
  return entry.lifecycle
    || entry.lifecycle_state
    || entry.lifecycleState
    || entry.status
    || 'unknown';
}

function eventResult(event = {}) {
  return event.policyResult
    || (event.policy && event.policy.result)
    || event.decision
    || '';
}

function eventReasons(event = {}) {
  return asArray(event.reasons || (event.policy && event.policy.reasons) || event.policyReasons || event.classifier_reason);
}

function eventAction(event = {}) {
  return [
    event.action,
    event.tool,
    event.sink,
    event.eventType,
    eventResult(event),
    ...eventReasons(event),
  ].filter(Boolean).join(' ');
}

function classifyDeathGripAction(actionText = '') {
  for (const [name, pattern] of DEATH_GRIP_PATTERNS) {
    if (pattern.test(actionText)) return name;
  }
  return '';
}

function originRisk(origins = []) {
  const normalized = asArray(origins);
  return {
    quarantine: normalized.filter((origin) => origin.partition === PARTITIONS.QUARANTINE).length,
    candidate: normalized.filter((origin) => origin.partition === PARTITIONS.CANDIDATE).length,
    sensitive: normalized.filter((origin) => origin.partition === PARTITIONS.SENSITIVE).length,
    lowTrust: normalized.filter((origin) => ['external_low', 'untrusted', 'sensitive'].includes(origin.source_trust_level)).length,
  };
}

function summarizeEntries(entries = []) {
  const partitions = {};
  const trust = {};
  const lifecycle = {};
  const untrustedInTrusted = [];
  const externalTrusted = [];
  const autoPromotionRisks = [];

  for (const entry of entries) {
    const partition = partitionOf(entry);
    const sourceTrust = trustOf(entry);
    const state = lifecycleOf(entry);
    inc(partitions, partition);
    inc(trust, sourceTrust);
    inc(lifecycle, state);

    if (partition === PARTITIONS.TRUSTED && ['external_low', 'untrusted'].includes(sourceTrust)) {
      untrustedInTrusted.push(entry.id || entry.entry_id || entry.name || 'unknown');
    }
    if (partition === PARTITIONS.TRUSTED && /external|web|pdf|connector|import/i.test(entry.source_type || entry.sourceType || '')) {
      externalTrusted.push(entry.id || entry.entry_id || entry.name || 'unknown');
    }
    if (['validated', 'active', 'promoted'].includes(state) && [PARTITIONS.CANDIDATE, PARTITIONS.QUARANTINE].includes(partition)) {
      autoPromotionRisks.push(entry.id || entry.entry_id || entry.name || 'unknown');
    }
  }

  return {
    total: entries.length,
    partitions,
    trust,
    lifecycle,
    risks: {
      untrustedInTrusted,
      externalTrusted,
      autoPromotionRisks,
    },
  };
}

function summarizeSecurityEvents(events = []) {
  const byResult = {};
  const byEventType = {};
  const byPartition = {};
  const deathGripAttempts = {};
  const quarantineEvents = [];
  const deniedEvents = [];
  const approvalEvents = [];

  for (const event of events) {
    const result = eventResult(event);
    const type = event.eventType || event.type || 'unknown';
    const partition = event.partition || (event.resource && event.resource.partition) || 'unknown';
    inc(byResult, result || 'unknown');
    inc(byEventType, type);
    inc(byPartition, partition);

    if (result === 'quarantine' || partition === PARTITIONS.QUARANTINE) {
      quarantineEvents.push(event.id || event.eventHash || event.subject || 'unknown');
    }
    if (result === 'deny' || result === 'blocked') {
      deniedEvents.push(event.id || event.eventHash || event.subject || 'unknown');
    }
    if (result === 'require_human_approval' || type === 'human_approval_requested') {
      approvalEvents.push(event.id || event.eventHash || event.subject || 'unknown');
    }

    const deathGrip = classifyDeathGripAction(eventAction(event));
    if (deathGrip) inc(deathGripAttempts, deathGrip);
  }

  return {
    total: events.length,
    byResult,
    byEventType,
    byPartition,
    deathGripAttempts,
    counts: {
      quarantineEvents: quarantineEvents.length,
      deniedEvents: deniedEvents.length,
      approvalEvents: approvalEvents.length,
    },
    recent: {
      quarantineEvents: quarantineEvents.slice(-10),
      deniedEvents: deniedEvents.slice(-10),
      approvalEvents: approvalEvents.slice(-10),
    },
  };
}

function summarizeBehavior(runs = [], approvals = []) {
  const byStatus = {};
  const byTool = {};
  const byAction = {};
  const deathGripAttempts = {};
  const originSignals = {
    quarantine: 0,
    candidate: 0,
    sensitive: 0,
    lowTrust: 0,
  };
  const blockedRuns = [];
  const approvalRequiredRuns = [];
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');

  for (const run of runs) {
    inc(byStatus, run.status);
    inc(byTool, run.tool);
    inc(byAction, run.action);
    const deathGrip = classifyDeathGripAction([run.tool, run.action, ...asArray(run.policy_reasons)].join(' '));
    if (deathGrip) inc(deathGripAttempts, deathGrip);
    const risk = originRisk(run.input_origins);
    originSignals.quarantine += risk.quarantine;
    originSignals.candidate += risk.candidate;
    originSignals.sensitive += risk.sensitive;
    originSignals.lowTrust += risk.lowTrust;
    if (run.status === 'blocked') blockedRuns.push(run.run_id);
    if (run.status === 'approval_required') approvalRequiredRuns.push(run.run_id);
  }

  return {
    totalRuns: runs.length,
    byStatus,
    byTool,
    byAction,
    deathGripAttempts,
    originSignals,
    pendingApprovals: pendingApprovals.length,
    blockedRuns: blockedRuns.slice(-10),
    approvalRequiredRuns: approvalRequiredRuns.slice(-10),
  };
}

function feverModeFor({ entries, security, behavior }) {
  let score = 0;
  const reasons = [];
  const deathGripCount = Object.values(security.deathGripAttempts).reduce((sum, value) => sum + value, 0)
    + Object.values(behavior.deathGripAttempts).reduce((sum, value) => sum + value, 0);

  if (entries.risks.untrustedInTrusted.length) {
    score += 30;
    reasons.push('untrusted_content_in_trusted_kb');
  }
  if (entries.risks.autoPromotionRisks.length) {
    score += 25;
    reasons.push('candidate_or_quarantine_marked_promoted');
  }
  if (security.counts.quarantineEvents) {
    score += Math.min(25, security.counts.quarantineEvents * 5);
    reasons.push('quarantine_activity_present');
  }
  if (security.counts.deniedEvents) {
    score += Math.min(20, security.counts.deniedEvents * 4);
    reasons.push('policy_denials_present');
  }
  if (deathGripCount) {
    score += Math.min(35, deathGripCount * 7);
    reasons.push('death_grip_action_pressure');
  }
  if (behavior.pendingApprovals) {
    score += Math.min(15, behavior.pendingApprovals * 5);
    reasons.push('pending_high_risk_approvals');
  }
  if (behavior.originSignals.quarantine || behavior.originSignals.sensitive) {
    score += 20;
    reasons.push('high_risk_origins_reached_feature_layer');
  }

  const level = score >= 70 ? 'freeze_review'
    : score >= 40 ? 'high_friction'
      : score >= 15 ? 'elevated_caution'
        : 'normal';
  return {
    level,
    score,
    reasons,
    recommendedFriction: level === 'freeze_review'
      ? ['freeze_high_risk_tools', 'snapshot_state', 'human_review_required', 'quarantine_residue']
      : level === 'high_friction'
        ? ['require_human_approval_for_death_grip_actions', 'limit_exports', 'rescan_recent_memory']
        : level === 'elevated_caution'
          ? ['surface_review_banner', 'tighten_external_exports', 'review_pending_approvals']
          : [],
  };
}

function buildMemoryEcosystemHealthReport(input = {}) {
  const entries = summarizeEntries(asArray(input.entries));
  const security = summarizeSecurityEvents(asArray(input.securityEvents));
  const behavior = summarizeBehavior(asArray(input.featureRuns), asArray(input.approvals));
  const feverMode = feverModeFor({ entries, security, behavior });
  const errors = [];
  const warnings = [];

  if (entries.risks.untrustedInTrusted.length) errors.push('untrusted_content_in_trusted_kb');
  if (entries.risks.autoPromotionRisks.length) errors.push('invalid_promotion_state');
  if (feverMode.level === 'freeze_review') errors.push('fever_mode_freeze_review_recommended');
  if (feverMode.level === 'high_friction') warnings.push('fever_mode_high_friction_recommended');
  if (feverMode.level === 'elevated_caution') warnings.push('fever_mode_elevated_caution_recommended');
  if (security.counts.quarantineEvents) warnings.push('quarantine_activity_present');
  if (behavior.pendingApprovals) warnings.push('pending_feature_approvals');

  const status = errors.length ? 'needs_attention' : warnings.length ? 'warning' : 'healthy';
  return {
    ok: errors.length === 0,
    status,
    generatedAt: input.now || new Date().toISOString(),
    projectId: input.projectId || 'recall-local',
    entries,
    security,
    behavior,
    feverMode,
    errors,
    warnings,
    researchGrounding: [
      'behavioral-immune-layer-ai-defense-2026',
      'neurotaint-2026-llm-agent-information-flow',
      'kairos-2024-whole-system-provenance-ids',
      'camel-2025-defeating-prompt-injections',
      'memorygraft-2025-poisoned-experience-retrieval',
    ],
  };
}

function buildMemoryEcosystemHealthReportFromFiles(opts = {}) {
  return buildMemoryEcosystemHealthReport({
    projectId: opts.projectId || opts.project || 'recall-local',
    now: opts.now,
    entries: readEntries(opts.entriesPath),
    securityEvents: readJsonl(opts.auditPath),
    featureRuns: readJsonl(opts.runPath),
    approvals: readJsonl(opts.approvalPath),
  });
}

module.exports = {
  DEATH_GRIP_ACTIONS,
  PARTITIONS,
  buildMemoryEcosystemHealthReport,
  buildMemoryEcosystemHealthReportFromFiles,
  classifyDeathGripAction,
  readEntries,
  readJsonl,
};
