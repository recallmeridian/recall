'use strict';

const fs = require('fs');
const path = require('path');
const { canonicalSha256 } = require('./canonical-json');
const { DECISIONS, normalizeValueOrigin } = require('./feature-capability');
const { normalizeSecurityEvent } = require('./security-event');

const APPROVAL_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
};

const APPROVAL_DECISIONS = {
  APPROVE: 'approve',
  DENY: 'deny',
};

const WARNING_VARIANTS = [
  'consequence_first',
  'permission_slip',
  'source_risk_review',
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeRequest(input = {}) {
  const tool = input.tool || (input.request && input.request.tool) || '';
  const action = input.action || (input.request && input.request.action) || tool;
  if (!tool || !action) {
    throw new Error('Approval request requires tool and action.');
  }
  return { tool, action };
}

function normalizedOrigins(input = {}) {
  return asArray(input.values || input.valueOrigins).map(normalizeValueOrigin);
}

function approvalIdFor(shape) {
  return canonicalSha256(shape).replace('sha256:', 'approval-').slice(0, 25);
}

function warningVariantFor(approvalId) {
  const last = approvalId.charCodeAt(approvalId.length - 1);
  return WARNING_VARIANTS[last % WARNING_VARIANTS.length];
}

function buildApprovalRequest(input = {}, context = {}) {
  const capabilityResult = input.capabilityResult || {};
  if (capabilityResult.decision !== DECISIONS.REQUIRE_HUMAN_APPROVAL) {
    throw new Error('Approval request can only be created for require_human_approval decisions.');
  }

  const request = normalizeRequest(input);
  const valueOrigins = normalizedOrigins(input);
  const reasons = asArray(capabilityResult.reasons);
  const idShape = {
    tool: request.tool,
    action: request.action,
    reasons,
    valueOrigins,
    actor: context.actor || '',
    userId: context.userId || '',
  };
  const approvalId = input.approvalId || approvalIdFor(idShape);
  const requestedAt = context.now || context.timestamp || new Date().toISOString();
  const record = {
    id: approvalId,
    status: APPROVAL_STATUS.PENDING,
    tool: request.tool,
    action: request.action,
    reasons,
    valueOrigins,
    warningVariant: warningVariantFor(approvalId),
    requestedBy: context.actor || 'system',
    userId: context.userId || '',
    createdAt: requestedAt,
    updatedAt: requestedAt,
    expiresAt: context.expiresAt || '',
    rawValuePolicy: 'origins_only_no_raw_values',
  };

  return {
    ...record,
    securityEvent: normalizeSecurityEvent({
      eventType: 'human_approval_requested',
      eventId: `${approvalId}:requested`,
      timestamp: requestedAt,
      tool: request.tool,
      action: request.action,
      policyDecision: DECISIONS.REQUIRE_HUMAN_APPROVAL,
      policyReasons: reasons,
    }, {
      actor: context.actor || 'system',
      action: 'request_human_approval',
      resourceId: approvalId,
      resourceType: 'approval_request',
      projectId: context.projectId || '',
      userId: context.userId || '',
      codeNamespace: 'recall.approval_queue',
    }),
  };
}

function decideApproval(record, input = {}, context = {}) {
  if (!record || record.status !== APPROVAL_STATUS.PENDING) {
    throw new Error('Only pending approval requests can be decided.');
  }
  const decision = input.decision;
  if (![APPROVAL_DECISIONS.APPROVE, APPROVAL_DECISIONS.DENY].includes(decision)) {
    throw new Error('Approval decision must be approve or deny.');
  }
  if (!input.approverId) {
    throw new Error('Approval decision requires approverId.');
  }
  if (!input.justification) {
    throw new Error('Approval decision requires justification.');
  }

  const decidedAt = context.now || context.timestamp || new Date().toISOString();
  const status = decision === APPROVAL_DECISIONS.APPROVE
    ? APPROVAL_STATUS.APPROVED
    : APPROVAL_STATUS.DENIED;
  const next = {
    ...record,
    status,
    approvalDecision: decision,
    approverId: input.approverId,
    justification: input.justification,
    updatedAt: decidedAt,
    decidedAt,
  };

  return {
    ...next,
    securityEvent: normalizeSecurityEvent({
      eventType: 'human_approval_decided',
      eventId: `${record.id}:${decision}`,
      timestamp: decidedAt,
      tool: record.tool,
      action: record.action,
      policyDecision: status,
      policyReasons: [decision === APPROVAL_DECISIONS.APPROVE ? 'human_approved' : 'human_denied'],
    }, {
      actor: input.approverId,
      action: `human_approval_${decision}`,
      resourceId: record.id,
      resourceType: 'approval_request',
      projectId: context.projectId || '',
      userId: record.userId || context.userId || '',
      codeNamespace: 'recall.approval_queue',
    }),
  };
}

function canExecuteWithApproval(capabilityResult, approvalRecord) {
  if (!capabilityResult || capabilityResult.decision === DECISIONS.DENY) {
    return {
      allowed: false,
      reasons: ['capability_denied'],
    };
  }
  if (capabilityResult.decision === DECISIONS.ALLOW) {
    return {
      allowed: true,
      reasons: ['capability_allowed'],
    };
  }
  if (!approvalRecord || approvalRecord.status !== APPROVAL_STATUS.APPROVED) {
    return {
      allowed: false,
      reasons: ['human_approval_required_pending'],
    };
  }
  return {
    allowed: true,
    reasons: ['human_approval_granted'],
    approvalId: approvalRecord.id,
  };
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function appendApprovalRecord(filePath, record) {
  ensureParent(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

function readApprovalRecords(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function listApprovalRequests(filePath, filters = {}) {
  const latestById = new Map();
  for (const record of readApprovalRecords(filePath)) {
    latestById.set(record.id, record);
  }
  return Array.from(latestById.values())
    .filter((record) => !filters.status || record.status === filters.status)
    .filter((record) => !filters.tool || record.tool === filters.tool)
    .filter((record) => !filters.action || record.action === filters.action)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)) || left.id.localeCompare(right.id));
}

function decideApprovalInQueue(filePath, approvalId, input = {}, context = {}) {
  const existing = listApprovalRequests(filePath).find((record) => record.id === approvalId);
  if (!existing) {
    throw new Error(`Approval request not found: ${approvalId}`);
  }
  return appendApprovalRecord(filePath, decideApproval(existing, input, context));
}

module.exports = {
  APPROVAL_DECISIONS,
  APPROVAL_STATUS,
  appendApprovalRecord,
  buildApprovalRequest,
  canExecuteWithApproval,
  decideApproval,
  decideApprovalInQueue,
  listApprovalRequests,
  readApprovalRecords,
};
