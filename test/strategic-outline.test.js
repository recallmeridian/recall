'use strict';

const path = require('path');
const { gatherProjectStatus, loadAlignment, groupByPeak, renderMarkdown, renderHtml } = require('../lib/strategic-outline');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'strategic-outline', 'recall-fixture');

describe('gatherProjectStatus', () => {
  test('reads milestones, todos, decisions from config.json for a populated project', () => {
    const status = gatherProjectStatus(FIXTURE_ROOT, 'fixture-trading');
    expect(status.id).toBe('fixture-trading');
    expect(status.milestonesDone).toBe(1);
    expect(status.milestonesTotal).toBe(4);
    expect(status.openTodos).toBe(2);          // 2 with status:"open", 1 with status:"done"
    expect(status.openDecisions).toBe(0);       // fixture-trading has no decisions
    expect(status.parseError).toBeFalsy();
    expect(status.openMilestones).toHaveLength(3);
    expect(status.openTodoEntries).toHaveLength(2);
  });

  test('returns empty counts for a project not in config.json', () => {
    const status = gatherProjectStatus(FIXTURE_ROOT, 'nonexistent-project');
    expect(status.id).toBe('nonexistent-project');
    expect(status.milestonesDone).toBe(0);
    expect(status.milestonesTotal).toBe(0);
    expect(status.openTodos).toBe(0);
    expect(status.openDecisions).toBe(0);
  });

  test('handles project with only milestones (no todos, no decisions)', () => {
    const status = gatherProjectStatus(FIXTURE_ROOT, 'fixture-product');
    expect(status.milestonesDone).toBe(1);
    expect(status.milestonesTotal).toBe(2);
    expect(status.openTodos).toBe(0);
  });

  test('returns parseError: true when config.json is malformed', () => {
    const fs = require('fs');
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gather-bad-'));
    fs.writeFileSync(path.join(tmp, 'config.json'), 'not-valid-json');
    const status = gatherProjectStatus(tmp, 'anything');
    expect(status.parseError).toBe(true);
  });

  test('handles project with todos.status === "done" correctly (not counted as open)', () => {
    const status = gatherProjectStatus(FIXTURE_ROOT, 'fixture-trading');
    // fixture-trading todos: 2 open, 1 done — only the 2 are counted as open
    expect(status.openTodos).toBe(2);
  });
});

describe('loadAlignment', () => {
  test('reads peak-alignment.json from fixture root', () => {
    const a = loadAlignment(FIXTURE_ROOT);
    expect(a.version).toBe(1);
    expect(a.peaks).toHaveLength(3);
    expect(a.peaks[0].id).toBe('peak-1');
    expect(a.peaks[0].projects).toEqual(['fixture-trading']);
    expect(a.peaks[2].projects).toEqual([]);
    expect(a.foundation).toEqual(['fixture-research']);
    expect(a.offPeak).toEqual(['fixture-empty']);
    expect(a.scaffolded).toBe(false);
  });

  test('returns scaffold default when peak-alignment.json missing', () => {
    const fs = require('fs');
    const os = require('os');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'load-align-'));
    const a = loadAlignment(tmpRoot);
    expect(a.version).toBe(1);
    expect(a.peaks).toEqual([]);
    expect(a.scaffolded).toBe(true);
  });
});

describe('groupByPeak', () => {
  test('partitions statuses into peaks/foundation/offPeak/unmapped', () => {
    const alignment = loadAlignment(FIXTURE_ROOT);
    const ids = ['fixture-trading', 'fixture-product', 'fixture-research', 'fixture-empty', 'fixture-unmapped'];
    const statuses = ids.map((id) => gatherProjectStatus(FIXTURE_ROOT, id));
    const grouped = groupByPeak(statuses, alignment);

    expect(grouped.peaks[0].projects.map((p) => p.status.id)).toEqual(['fixture-trading']);
    expect(grouped.peaks[1].projects[0].status.id).toBe('fixture-product');
    expect(grouped.peaks[1].projects[0].crossPeakNote).toMatch(/cross-peak relevance/i);
    expect(grouped.peaks[2].projects).toEqual([]);
    expect(grouped.foundation.map((s) => s.id)).toEqual(['fixture-research']);
    expect(grouped.offPeak.map((s) => s.id)).toEqual(['fixture-empty']);
    expect(grouped.unmapped.map((s) => s.id)).toEqual(['fixture-unmapped']);
  });

  test('peak with empty projects[] yields empty projects array (no crash)', () => {
    const alignment = loadAlignment(FIXTURE_ROOT);
    const statuses = [];
    const grouped = groupByPeak(statuses, alignment);
    expect(grouped.peaks[2].projects).toEqual([]);
  });
});

describe('renderMarkdown', () => {
  test('matches golden snapshot for fixture KB', () => {
    const alignment = loadAlignment(FIXTURE_ROOT);
    const ids = ['fixture-trading', 'fixture-product', 'fixture-research', 'fixture-empty', 'fixture-unmapped'];
    const statuses = ids.map((id) => gatherProjectStatus(FIXTURE_ROOT, id));
    const grouped = groupByPeak(statuses, alignment);
    const md = renderMarkdown(grouped, alignment, { generatedAt: '2026-05-10T00:00:00Z', daysInvisible: 0 });

    const goldenPath = path.join(__dirname, 'fixtures', 'strategic-outline', 'golden-outline.md');
    const golden = require('fs').readFileSync(goldenPath, 'utf8');
    expect(md).toBe(golden);
  });
});

describe('renderHtml', () => {
  test('matches golden HTML snapshot for fixture KB', () => {
    const alignment = loadAlignment(FIXTURE_ROOT);
    const ids = ['fixture-trading', 'fixture-product', 'fixture-research', 'fixture-empty', 'fixture-unmapped'];
    const statuses = ids.map((id) => gatherProjectStatus(FIXTURE_ROOT, id));
    const grouped = groupByPeak(statuses, alignment);
    const html = renderHtml(grouped, alignment, { generatedAt: '2026-05-10T00:00:00Z', daysInvisible: 0 });

    const goldenPath = path.join(__dirname, 'fixtures', 'strategic-outline', 'golden-outline.html');
    const golden = require('fs').readFileSync(goldenPath, 'utf8');
    expect(html).toBe(golden);
  });
});

const os = require('os');
const fs = require('fs');
const { escalatePeak, clearPeakInvisibility } = require('../lib/strategic-outline');

describe('escalatePeak', () => {
  let tmpDir;
  let stateFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strat-outline-'));
    stateFile = path.join(tmpDir, 'state.json');
  });

  test('first call writes timestamp and returns 0 days', () => {
    const days = escalatePeak('peak-3', stateFile, new Date('2026-05-10T00:00:00Z'));
    expect(days).toBe(0);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(state.invisibleSince['peak-3']).toBe('2026-05-10T00:00:00.000Z');
  });

  test('subsequent call returns elapsed days from stored timestamp', () => {
    escalatePeak('peak-3', stateFile, new Date('2026-05-10T00:00:00Z'));
    const days = escalatePeak('peak-3', stateFile, new Date('2026-06-29T00:00:00Z'));
    expect(days).toBe(50);
  });

  test('different peakId tracked independently', () => {
    escalatePeak('peak-3', stateFile, new Date('2026-05-10T00:00:00Z'));
    escalatePeak('peak-4', stateFile, new Date('2026-05-15T00:00:00Z'));
    const days = escalatePeak('peak-4', stateFile, new Date('2026-05-20T00:00:00Z'));
    expect(days).toBe(5);
  });

  test('clearPeakInvisibility removes the timestamp so next call resets to 0', () => {
    escalatePeak('peak-3', stateFile, new Date('2026-05-10T00:00:00Z'));
    clearPeakInvisibility('peak-3', stateFile);
    const days = escalatePeak('peak-3', stateFile, new Date('2026-06-01T00:00:00Z'));
    expect(days).toBe(0);
  });

  test('clearPeakInvisibility on a missing state file is a no-op', () => {
    expect(() => clearPeakInvisibility('peak-3', stateFile)).not.toThrow();
  });
});

const { regenerate } = require('../lib/strategic-outline');

describe('regenerate', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strat-outline-regen-'));
    // Copy fixture root contents (config.json + peak-alignment.json) into tmpRoot
    const src = FIXTURE_ROOT;
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.isFile()) {
        fs.copyFileSync(path.join(src, entry.name), path.join(tmpRoot, entry.name));
      }
    }
  });

  test('writes both markdown and html files and returns their paths', () => {
    const result = regenerate(tmpRoot, { now: new Date('2026-05-10T00:00:00Z') });
    expect(result.markdownPath).toBe(path.join(tmpRoot, 'strategic-outline.md'));
    expect(result.htmlPath).toBe(path.join(tmpRoot, 'strategic-outline.html'));
    expect(fs.existsSync(result.markdownPath)).toBe(true);
    expect(fs.existsSync(result.htmlPath)).toBe(true);
    expect(result.projectCount).toBe(5);

    const md = fs.readFileSync(result.markdownPath, 'utf8');
    expect(md).toContain('Strategic Outline');
    expect(md).toContain('fixture-trading');
    expect(md).toContain('Unified intelligence substrate');
  });

  test('escalates Peak 3 days when run again at a later time', () => {
    regenerate(tmpRoot, { now: new Date('2026-05-10T00:00:00Z') });
    regenerate(tmpRoot, { now: new Date('2026-06-30T00:00:00Z') });
    const md = fs.readFileSync(path.join(tmpRoot, 'strategic-outline.md'), 'utf8');
    // 2026-06-30 minus 2026-05-10 = 51 days
    expect(md).toContain('Invisible for 51 days');
  });

  test('clears invisibility tracking when a previously empty peak gets a project', () => {
    // First run: peak-3 empty, gets tracked
    regenerate(tmpRoot, { now: new Date('2026-05-10T00:00:00Z') });
    const stateBefore = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'strategic-outline-state.json'), 'utf8'));
    expect(stateBefore.invisibleSince['peak-3']).toBeTruthy();

    // Add a project to peak-3 in alignment
    const alignmentPath = path.join(tmpRoot, 'peak-alignment.json');
    const alignment = JSON.parse(fs.readFileSync(alignmentPath, 'utf8'));
    alignment.peaks[2].projects = ['fixture-empty'];
    fs.writeFileSync(alignmentPath, JSON.stringify(alignment));

    // Second run: peak-3 now non-empty, tracking should clear
    regenerate(tmpRoot, { now: new Date('2026-05-15T00:00:00Z') });
    const stateAfter = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'strategic-outline-state.json'), 'utf8'));
    expect(stateAfter.invisibleSince['peak-3']).toBeFalsy();
  });
});
