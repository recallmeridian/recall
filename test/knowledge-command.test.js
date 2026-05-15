'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const bin = path.join(__dirname, '..', 'bin', 'meridian.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-command-'));
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      MERIDIAN_DATA: options.dataDir || tempDir(),
    },
  });
}

function writeJson(dir, name, value) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  return filePath;
}

describe('knowledge command transition ledger', () => {
  let dir;
  let ledgerPath;

  beforeEach(() => {
    dir = tempDir();
    ledgerPath = path.join(dir, 'knowledge-transitions.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('records, verifies, lists, and rollback-plans a knowledge transition', () => {
    const transitionPath = writeJson(dir, 'transition.json', {
      artifactId: 'lesson-1',
      from: 'candidate_belief',
      to: 'validated_knowledge',
      reasons: ['reviewed evidence'],
      evidenceRefs: ['recall://evidence/review-1'],
    });

    const recorded = run([
      'knowledge',
      'transition',
      transitionPath,
      '--ledger-path',
      ledgerPath,
      '--actor',
      'jesse',
      '--now',
      '2026-05-05T00:00:00.000Z',
      '--json',
    ], { dataDir: dir });
    expect(recorded.status).toBe(0);
    expect(JSON.parse(recorded.stdout)).toMatchObject({
      ok: true,
      record: {
        artifactId: 'lesson-1',
        event: {
          from: 'candidate_belief',
          to: 'validated_knowledge',
        },
      },
    });

    const verified = run(['knowledge', 'verify', '--ledger-path', ledgerPath, '--json'], { dataDir: dir });
    expect(verified.status).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ ok: true, count: 1 });

    const history = run(['knowledge', 'history', 'lesson-1', '--ledger-path', ledgerPath, '--json'], { dataDir: dir });
    expect(history.status).toBe(0);
    expect(JSON.parse(history.stdout)).toMatchObject({ ok: true, artifactId: 'lesson-1', count: 1 });

    const rollback = run([
      'knowledge',
      'rollback-plan',
      'lesson-1',
      '--ledger-path',
      ledgerPath,
      '--target-state',
      'retired',
      '--reason',
      'bad rule',
      '--json',
    ], { dataDir: dir });
    expect(rollback.status).toBe(0);
    expect(JSON.parse(rollback.stdout)).toMatchObject({
      canRollback: true,
      currentState: 'validated_knowledge',
      targetState: 'retired',
      suggestedTransition: {
        from: 'validated_knowledge',
        to: 'retired',
      },
    });
  });

  test('blocks bad promotion through CLI without writing a ledger record', () => {
    const transitionPath = writeJson(dir, 'bad-transition.json', {
      artifactId: 'external-claim-1',
      from: 'candidate_belief',
      to: 'validated_knowledge',
      reasons: ['seems good'],
      evidenceRefs: ['recall://source/web'],
      partition: 'candidate_basin',
      source_trust_level: 'external_low',
      entry: {
        entryType: 'skill',
        evidenceTypes: ['source_trace'],
      },
    });

    const result = run([
      'knowledge',
      'transition',
      transitionPath,
      '--ledger-path',
      ledgerPath,
      '--json',
    ], { dataDir: dir });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      event: {
        status: 'blocked',
        errors: expect.arrayContaining([
          'external_knowledge_requires_human_approval',
          'promotion_gate_missing:evaluation_evidence',
        ]),
      },
    });
    expect(fs.existsSync(ledgerPath)).toBe(false);
  });
});
