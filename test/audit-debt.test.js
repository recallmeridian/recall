'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const meridian = require('../lib/meridian-core');
const auditDebt = require('../lib/audit-debt');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recall-audit-debt-'));
}

describe('audit debt tracker', () => {
  let dir;
  let kb;

  beforeEach(() => {
    dir = tempDir();
    kb = meridian.init(path.join(dir, 'kb'));
  });

  afterEach(() => {
    if (kb) kb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('parses Claude audit result findings into structured debt rows', () => {
    const auditPath = path.join(dir, 'claude-audit-result-q2.md');
    fs.writeFileSync(auditPath, [
      '# Claude Audit Result',
      '',
      '## H1: Signed HTTP spec allows stale schema',
      'Severity: high',
      'Status: open',
      'File: docs/specs/signed-http.md:42',
      'The spec still mentions legacy schema behavior.',
      '',
      '## M2: Dashboard copy drift',
      'Severity: medium',
      'Status: fixed',
      'Closed in commit: abc1234',
      'File: dashboard.html:9',
    ].join('\n'));

    const findings = auditDebt.parseAuditFile(auditPath);

    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({
      auditId: 'claude-audit-result-q2',
      findingId: 'h1',
      severity: 'high',
      status: 'open',
      title: 'Signed HTTP spec allows stale schema',
    });
    expect(findings[0].fileRefs).toContain('docs/specs/signed-http.md:42');
    expect(findings[1]).toMatchObject({
      findingId: 'm2',
      severity: 'medium',
      status: 'closed',
      closedInCommit: 'abc1234',
    });
  });

  test('scans, lists, and closes audit debt in local Recall storage', () => {
    const auditPath = path.join(dir, 'claude-audit-result-q3.md');
    fs.writeFileSync(auditPath, [
      '## H1: Promotion gate can be bypassed',
      'Severity: high',
      'Status: open',
      'File: lib/promotion-policy.js:12',
      '',
      '## L2: Typo in prompt card',
      'Severity: low',
      'Status: open',
      'File: docs/prompt.md:3',
    ].join('\n'));

    const scan = auditDebt.scanAuditDebt(kb, dir);
    const open = auditDebt.listDebt(kb, { status: 'open' });
    const high = auditDebt.listDebt(kb, { severity: 'high' });
    const closed = auditDebt.closeDebt(kb, high[0].id, { commit: 'deadbeef' });
    const remainingOpen = auditDebt.listDebt(kb, { status: 'open' });

    expect(scan).toMatchObject({
      fileCount: 1,
      findingCount: 2,
      openCount: 2,
    });
    expect(open.map((finding) => finding.severity)).toEqual(['high', 'low']);
    expect(high).toHaveLength(1);
    expect(closed).toMatchObject({
      status: 'closed',
      closedInCommit: 'deadbeef',
    });
    expect(remainingOpen).toHaveLength(1);
    expect(remainingOpen[0].severity).toBe('low');
  });

  test('preserves manually closed findings across later scans of stale audit files', () => {
    const auditPath = path.join(dir, 'claude-audit-result-q4.md');
    fs.writeFileSync(auditPath, [
      '## H1: Stale finding',
      'Severity: high',
      'Status: open',
    ].join('\n'));

    auditDebt.scanAuditDebt(kb, dir);
    auditDebt.closeDebt(kb, 'claude-audit-result-q4-h1', { commit: 'feed123' });
    auditDebt.scanAuditDebt(kb, dir);
    const findings = auditDebt.listDebt(kb, {});

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      status: 'closed',
      closedInCommit: 'feed123',
    });
  });

  test('marks deleted open findings as stale_missing on rescan', () => {
    const auditPath = path.join(dir, 'claude-audit-result-q5.md');
    fs.writeFileSync(auditPath, [
      '## H1: Removed finding',
      'Severity: high',
      'Status: open',
      '',
      '## L2: Kept finding',
      'Severity: low',
      'Status: open',
    ].join('\n'));

    auditDebt.scanAuditDebt(kb, dir);
    fs.writeFileSync(auditPath, [
      '## L2: Kept finding',
      'Severity: low',
      'Status: open',
    ].join('\n'));
    auditDebt.scanAuditDebt(kb, dir);

    const all = auditDebt.listDebt(kb, {});
    const stale = all.find((finding) => finding.id === 'claude-audit-result-q5-h1');
    const open = auditDebt.listDebt(kb, { status: 'open' });

    expect(stale.status).toBe('stale_missing');
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe('claude-audit-result-q5-l2');
  });

  test('marks rows stale when the source audit file is deleted', () => {
    const auditPath = path.join(dir, 'claude-audit-result-deleted.md');
    fs.writeFileSync(auditPath, [
      '## H1: Deleted file finding',
      'Severity: high',
      'Status: open',
    ].join('\n'));

    auditDebt.scanAuditDebt(kb, dir);
    fs.unlinkSync(auditPath);
    auditDebt.scanAuditDebt(kb, dir);

    const all = auditDebt.listDebt(kb, {});
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id: 'claude-audit-result-deleted-h1',
      status: 'stale_missing',
    });
  });

  test('revives stale_missing rows when a finding reappears', () => {
    const auditPath = path.join(dir, 'claude-audit-result-revived.md');
    fs.writeFileSync(auditPath, [
      '## H1: Revived finding',
      'Severity: high',
      'Status: open',
    ].join('\n'));

    auditDebt.scanAuditDebt(kb, dir);
    fs.writeFileSync(auditPath, '# Empty audit\n');
    auditDebt.scanAuditDebt(kb, dir);
    expect(auditDebt.listDebt(kb, {})[0].status).toBe('stale_missing');

    fs.writeFileSync(auditPath, [
      '## H1: Revived finding',
      'Severity: high',
      'Status: open',
    ].join('\n'));
    auditDebt.scanAuditDebt(kb, dir);

    expect(auditDebt.listDebt(kb, {})[0].status).toBe('open');
  });

  test('ignores summary headings while accepting bracket severity headings and BOM files', () => {
    const auditPath = path.join(dir, 'claude-audit-result-q6.md');
    fs.writeFileSync(auditPath, [
      '\uFEFF# Claude Audit Result',
      '',
      '## Findings Summary',
      'This is not a finding.',
      '',
      '## [HIGH] Bracketed severe finding',
      'Status: in progress',
      'File: lib/high.js:3',
      '',
      '## Severity Definitions',
      'High means important.',
    ].join('\n'));

    const findings = auditDebt.parseAuditFile(auditPath);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      findingId: 'finding-1',
      severity: 'high',
      status: 'open',
      title: 'Bracketed severe finding',
    });
  });

  test('suffixes duplicate finding ids from the same audit file', () => {
    const auditPath = path.join(dir, 'claude-audit-result-q7.md');
    fs.writeFileSync(auditPath, [
      '## H1: First duplicate',
      'Severity: high',
      '',
      '## H1: Second duplicate',
      'Severity: high',
    ].join('\n'));

    const findings = auditDebt.parseAuditFile(auditPath);

    expect(findings.map((finding) => finding.id)).toEqual([
      'claude-audit-result-q7-h1',
      'claude-audit-result-q7-h1-2',
    ]);
  });

  test('handles invalid limits and requires commits for library closes', () => {
    const auditPath = path.join(dir, 'claude-audit-result-q8.md');
    fs.writeFileSync(auditPath, [
      '## H1: Limit finding',
      'Severity: high',
    ].join('\n'));

    auditDebt.scanAuditDebt(kb, dir);

    expect(auditDebt.listDebt(kb, { limit: 'not-a-number' })).toHaveLength(1);
    expect(() => auditDebt.closeDebt(kb, 'claude-audit-result-q8-h1', {})).toThrow(/commit/i);
  });
});
