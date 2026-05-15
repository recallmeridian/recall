'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  APPROVAL_DECISIONS,
  APPROVAL_STATUS,
  appendApprovalRecord,
  buildApprovalRequest,
  canExecuteWithApproval,
  decideApproval,
  decideApprovalInQueue,
  listApprovalRequests,
  readApprovalRecords,
} = require('../lib/approval-queue');
const {
  DECISIONS,
  canInvokeTool,
} = require('../lib/feature-capability');

const externalCandidate = {
  value: 'external market note',
  origin: {
    partition: 'candidate_basin',
    source_trust_level: 'external_low',
    source_type: 'external_pdf',
    entry_id: 'candidate-1',
  },
};

describe('GEO-SEC-036 human approval queue', () => {
  let dir;
  let queuePath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-sec-036-'));
    queuePath = path.join(dir, 'approval-queue.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('creates a pending approval request from a capability review decision', () => {
    const capabilityResult = canInvokeTool({ tool: 'email', action: 'email:external' }, [externalCandidate], {
      requires_approval: [
        { tool: 'email', action: 'email:external' },
      ],
    });

    const request = buildApprovalRequest({
      tool: 'email',
      action: 'email:external',
      values: [externalCandidate],
      capabilityResult,
    }, {
      actor: 'feature-runner',
      userId: 'user-1',
      projectId: 'recall-local',
      now: '2026-05-03T00:00:00.000Z',
    });

    expect(request).toMatchObject({
      status: APPROVAL_STATUS.PENDING,
      tool: 'email',
      action: 'email:external',
      reasons: ['human_approval_required', 'untrusted_value_requires_review'],
      requestedBy: 'feature-runner',
      rawValuePolicy: 'origins_only_no_raw_values',
      valueOrigins: [
        {
          partition: 'candidate_basin',
          source_trust_level: 'external_low',
          source_type: 'external_pdf',
          value_id: 'candidate-1',
        },
      ],
      securityEvent: {
        eventSchemaVersion: 'security-event/v1',
        type: 'dev.recall.security.human_approval_requested',
        eventType: 'human_approval_requested',
        policyResult: DECISIONS.REQUIRE_HUMAN_APPROVAL,
        resource: {
          type: 'approval_request',
          projectId: 'recall-local',
        },
        attributes: {
          'code.namespace': 'recall.approval_queue',
          'user.id': 'user-1',
          'recall.action': 'request_human_approval',
        },
      },
    });
    expect(['consequence_first', 'permission_slip', 'source_risk_review']).toContain(request.warningVariant);
    expect(JSON.stringify(request)).not.toContain('external market note');
  });

  test('does not create approvals for allow or deny decisions', () => {
    expect(() => buildApprovalRequest({
      tool: 'notes.search',
      action: 'notes.search',
      capabilityResult: {
        decision: DECISIONS.ALLOW,
        reasons: ['explicit_policy_allow'],
      },
    })).toThrow('Approval request can only be created for require_human_approval decisions.');

    expect(() => buildApprovalRequest({
      tool: 'runner',
      action: 'run:code',
      capabilityResult: {
        decision: DECISIONS.DENY,
        reasons: ['policy_no_matching_capability'],
      },
    })).toThrow('Approval request can only be created for require_human_approval decisions.');
  });

  test('blocks execution until a matching pending request is approved', () => {
    const capabilityResult = {
      decision: DECISIONS.REQUIRE_HUMAN_APPROVAL,
      reasons: ['human_approval_required'],
    };
    const request = buildApprovalRequest({
      tool: 'email',
      action: 'email:external',
      capabilityResult,
    }, {
      now: '2026-05-03T00:00:00.000Z',
    });

    expect(canExecuteWithApproval(capabilityResult, request)).toEqual({
      allowed: false,
      reasons: ['human_approval_required_pending'],
    });

    const approved = decideApproval(request, {
      decision: APPROVAL_DECISIONS.APPROVE,
      approverId: 'jesse',
      justification: 'Reviewed recipient and untrusted source context.',
    }, {
      now: '2026-05-03T00:01:00.000Z',
    });

    expect(approved).toMatchObject({
      status: APPROVAL_STATUS.APPROVED,
      approvalDecision: APPROVAL_DECISIONS.APPROVE,
      approverId: 'jesse',
      securityEvent: {
        type: 'dev.recall.security.human_approval_decided',
        policyResult: APPROVAL_STATUS.APPROVED,
        reasons: ['human_approved'],
      },
    });
    expect(canExecuteWithApproval(capabilityResult, approved)).toEqual({
      allowed: true,
      reasons: ['human_approval_granted'],
      approvalId: approved.id,
    });
  });

  test('records denial decisions and keeps execution blocked', () => {
    const capabilityResult = {
      decision: DECISIONS.REQUIRE_HUMAN_APPROVAL,
      reasons: ['human_approval_required'],
    };
    const request = buildApprovalRequest({
      tool: 'exporter',
      action: 'database:export',
      capabilityResult,
    });
    const denied = decideApproval(request, {
      decision: APPROVAL_DECISIONS.DENY,
      approverId: 'jesse',
      justification: 'Export scope was too broad.',
    });

    expect(denied.status).toBe(APPROVAL_STATUS.DENIED);
    expect(canExecuteWithApproval(capabilityResult, denied)).toEqual({
      allowed: false,
      reasons: ['human_approval_required_pending'],
    });
  });

  test('requires approver identity and justification', () => {
    const request = buildApprovalRequest({
      tool: 'email',
      action: 'email:external',
      capabilityResult: {
        decision: DECISIONS.REQUIRE_HUMAN_APPROVAL,
        reasons: ['human_approval_required'],
      },
    });

    expect(() => decideApproval(request, {
      decision: APPROVAL_DECISIONS.APPROVE,
      justification: 'ok',
    })).toThrow('Approval decision requires approverId.');
    expect(() => decideApproval(request, {
      decision: APPROVAL_DECISIONS.APPROVE,
      approverId: 'jesse',
    })).toThrow('Approval decision requires justification.');
  });

  test('stores approval requests as append-only queue records and lists latest state', () => {
    const capabilityResult = {
      decision: DECISIONS.REQUIRE_HUMAN_APPROVAL,
      reasons: ['human_approval_required'],
    };
    const request = buildApprovalRequest({
      tool: 'email',
      action: 'email:external',
      capabilityResult,
    }, {
      now: '2026-05-03T00:00:00.000Z',
    });

    appendApprovalRecord(queuePath, request);
    const approved = decideApprovalInQueue(queuePath, request.id, {
      decision: APPROVAL_DECISIONS.APPROVE,
      approverId: 'jesse',
      justification: 'Recipient and source context reviewed.',
    }, {
      now: '2026-05-03T00:01:00.000Z',
    });

    expect(readApprovalRecords(queuePath)).toHaveLength(2);
    expect(listApprovalRequests(queuePath)).toEqual([approved]);
    expect(listApprovalRequests(queuePath, { status: APPROVAL_STATUS.PENDING })).toEqual([]);
    expect(listApprovalRequests(queuePath, { status: APPROVAL_STATUS.APPROVED })).toEqual([approved]);
  });

  test('rejects queue decisions for missing approval ids', () => {
    expect(() => decideApprovalInQueue(queuePath, 'approval-missing', {
      decision: APPROVAL_DECISIONS.APPROVE,
      approverId: 'jesse',
      justification: 'No such request.',
    })).toThrow('Approval request not found: approval-missing');
  });
});
