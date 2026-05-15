'use strict';

const DEFAULT_SKILLS = [
  'Recall/Meridian local knowledge workflows',
  'research synthesis',
  'CLI automation',
  'technical writing',
  'agent workflow design',
];

const DEFAULT_CONSTRAINTS = [
  'No impersonation or false claims about human authorship, credentials, employment status, or availability.',
  'No autonomous job applications, contract acceptance, platform messaging, trading, invoicing, or fund transfers.',
  'Human approval is required before contacting prospects, submitting work, accepting terms, or sharing payment details.',
  'Deliverables must be reviewed by the user before external delivery.',
  'Payment instructions can be prepared as text, but the user controls accounts, wallets, invoices, and withdrawals.',
];

const OPPORTUNITY_TEMPLATES = [
  {
    id: 'recall-setup-service',
    title: 'Recall setup and workflow package',
    buyer: 'Solo founders, researchers, and small technical teams with scattered notes or project memory.',
    offer: 'Install and configure a local Recall knowledge workflow, import approved docs, and deliver a short operating guide.',
    deliverables: [
      'Intake checklist for approved local source paths',
      'Configured Recall project with initial entries',
      'Search/query examples tailored to the buyer',
      'One-page handoff guide',
    ],
    estimatedPriceUsd: { low: 250, high: 900 },
    timeToFirstDollar: '1-7 days after a warm lead approves scope',
    risk: 'low',
  },
  {
    id: 'research-brief-sprint',
    title: 'Research brief sprint',
    buyer: 'Operators who need a fast, sourced brief before a build, purchase, or market decision.',
    offer: 'Use Recall to organize provided sources and produce a cited decision brief with gaps and next actions.',
    deliverables: [
      'Source manifest',
      'Evidence map',
      'Decision brief',
      'Open questions and validation plan',
    ],
    estimatedPriceUsd: { low: 150, high: 750 },
    timeToFirstDollar: '1-3 days when the buyer already has sources',
    risk: 'medium',
  },
  {
    id: 'agent-handoff-audit',
    title: 'Agent handoff and automation audit',
    buyer: 'Teams using coding agents who need safer handoffs, review trails, or repeatable automation runs.',
    offer: 'Review a repo workflow and produce an agent handoff ledger, safety gates, and a short remediation backlog.',
    deliverables: [
      'Workflow risk map',
      'Agent handoff template',
      'Command/test evidence list',
      'Scoped remediation backlog',
    ],
    estimatedPriceUsd: { low: 400, high: 1500 },
    timeToFirstDollar: '3-10 days depending on trust and repo access',
    risk: 'medium',
  },
];

function splitList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || '')
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePaymentRail(paymentRail) {
  const rail = String(paymentRail || '').trim();
  if (!rail) return 'user-controlled payment instructions';
  if (/crypto|wallet|btc|eth|usdc|sol/i.test(rail)) {
    return `${rail} (prepared as user-approved instructions only; no wallet access or transfer automation)`;
  }
  return rail;
}

function buildProposalDraft(card, opts = {}) {
  const name = opts.userName || 'Jesse';
  return [
    `Hi, I am ${name}. I can help with ${card.offer.toLowerCase()}`,
    '',
    'A tight first scope would be:',
    ...card.deliverables.map((item) => `- ${item}`),
    '',
    `Typical first engagement range: $${card.estimatedPriceUsd.low}-$${card.estimatedPriceUsd.high}, depending on scope and review cycles.`,
    '',
    'If useful, I can send a short intake checklist and a fixed-scope quote after you confirm the source material and desired outcome.',
  ].join('\n');
}

function buildActionCards(opts = {}) {
  const skills = splitList(opts.skills);
  const skillText = skills.length ? skills.join(' ').toLowerCase() : DEFAULT_SKILLS.join(' ').toLowerCase();
  return OPPORTUNITY_TEMPLATES
    .map((card) => {
      const skillBoost = card.deliverables.some((item) => skillText.includes(item.toLowerCase().split(' ')[0])) ? 1 : 0;
      const recallBoost = /recall|meridian|knowledge|research|agent|automation/.test(skillText) ? 2 : 0;
      const riskPenalty = card.risk === 'low' ? 0 : 1;
      const score = 5 + recallBoost + skillBoost - riskPenalty;
      return {
        ...card,
        score,
        approvalRequiredBefore: [
          'External outreach',
          'Proposal submission',
          'Contract acceptance',
          'Deliverable delivery',
          'Invoice or payment instruction sharing',
        ],
        proposalDraft: buildProposalDraft(card, opts),
      };
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

function buildIncomePipeline(opts = {}) {
  const goal = String(opts.goal || 'Make legitimate revenue using Recall as the operating base.').trim();
  const constraints = [...DEFAULT_CONSTRAINTS, ...splitList(opts.constraints)];
  const paymentRail = normalizePaymentRail(opts.paymentRail);
  const actionCards = buildActionCards(opts);
  const topCard = actionCards[0];

  return {
    kind: 'recall_income_pipeline_v1',
    goal,
    mode: 'human_approved_revenue_ops',
    paymentRail,
    guardrails: constraints,
    prohibitedAutonomy: [
      'Apply for jobs, create accounts, send messages, or negotiate as the user',
      'Represent generated work as unreviewed human work',
      'Accept contracts or terms',
      'Access bank, exchange, wallet, payroll, or tax systems',
      'Trade, gamble, invest, or transfer funds',
    ],
    phases: [
      {
        id: 'package-offer',
        title: 'Package one concrete offer',
        output: `${topCard.title}: ${topCard.offer}`,
      },
      {
        id: 'source-leads',
        title: 'Source leads for human review',
        output: 'Create a vetted lead list with source URLs, fit notes, and disqualifiers. Do not contact anyone automatically.',
      },
      {
        id: 'draft-outreach',
        title: 'Draft outreach and proposal',
        output: 'Prepare messages and scopes for the user to approve, edit, and send.',
      },
      {
        id: 'produce-deliverable',
        title: 'Produce reviewed deliverables',
        output: 'Use Recall to organize inputs, generate drafts, run checks, and produce a human-reviewed final packet.',
      },
      {
        id: 'prepare-payment',
        title: 'Prepare payment handoff',
        output: `Draft invoice/payment wording for ${paymentRail}; the user sends it and controls funds.`,
      },
    ],
    actionCards,
    nextHumanApprovals: [
      'Pick one offer to sell first',
      'Approve target buyer profile and outreach channel',
      'Approve any lead list before contact',
      'Approve proposal text and price',
      'Approve final deliverable and payment instructions',
    ],
  };
}

module.exports = {
  DEFAULT_CONSTRAINTS,
  OPPORTUNITY_TEMPLATES,
  buildIncomePipeline,
  buildActionCards,
  splitList,
};
