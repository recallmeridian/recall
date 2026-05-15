'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const bin = path.join(__dirname, '..', 'bin', 'meridian.js');

function run(args) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });
}

describe('income command', () => {
  test('prints a JSON income plan', () => {
    const result = run([
      'income',
      'plan',
      '--goal',
      'Make legitimate revenue using Recall',
      '--payment-rail',
      'crypto account',
      '--json',
    ]);

    expect(result.status).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.goal).toBe('Make legitimate revenue using Recall');
    expect(plan.paymentRail).toContain('no wallet access or transfer automation');
    expect(plan.actionCards[0].approvalRequiredBefore).toContain('Proposal submission');
  });

  test('prints a readable plan by default', () => {
    const result = run(['income', 'plan']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Recall Income Pipeline');
    expect(result.stdout).toContain('Approval Gates');
    expect(result.stdout).toContain('Apply for jobs');
  });
});
