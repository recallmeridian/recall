'use strict';

const { buildIncomePipeline } = require('../lib/income-pipeline');

describe('income pipeline', () => {
  test('builds human-approved revenue action cards with hard autonomy limits', () => {
    const plan = buildIncomePipeline({
      goal: 'Make legitimate money with Recall',
      paymentRail: 'USDC wallet',
      userName: 'Jesse',
    });

    expect(plan.kind).toBe('recall_income_pipeline_v1');
    expect(plan.mode).toBe('human_approved_revenue_ops');
    expect(plan.paymentRail).toContain('no wallet access or transfer automation');
    expect(plan.prohibitedAutonomy).toEqual(expect.arrayContaining([
      expect.stringContaining('Apply for jobs'),
      expect.stringContaining('transfer funds'),
    ]));
    expect(plan.actionCards.length).toBeGreaterThan(0);
    expect(plan.actionCards[0].proposalDraft).toContain('Hi, I am Jesse.');
    expect(plan.nextHumanApprovals).toEqual(expect.arrayContaining([
      'Approve proposal text and price',
    ]));
  });

  test('keeps external contact, contract acceptance, and payment sharing behind approvals', () => {
    const plan = buildIncomePipeline();

    for (const card of plan.actionCards) {
      expect(card.approvalRequiredBefore).toEqual(expect.arrayContaining([
        'External outreach',
        'Contract acceptance',
        'Invoice or payment instruction sharing',
      ]));
    }
  });
});
