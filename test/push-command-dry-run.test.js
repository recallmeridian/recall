'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readAuditEvents } = require('../lib/audit-sediment');

jest.mock('../lib/meridian-core', () => ({
  init: jest.fn(),
}));

jest.mock('../lib/cli-config', () => ({
  get: jest.fn(),
  getDataDir: jest.fn(),
}));

jest.mock('../lib/prompt', () => ({
  choose: jest.fn(),
}));

const meridian = require('../lib/meridian-core');
const cliConfig = require('../lib/cli-config');
const registerPush = require('../lib/commands/push');

function capturePushAction() {
  let action;
  const chain = {
    description: jest.fn(() => chain),
    option: jest.fn(() => chain),
    action: jest.fn((fn) => {
      action = fn;
      return chain;
    }),
  };
  const program = {
    command: jest.fn(() => chain),
  };

  registerPush(program);

  return { action, chain, program };
}

describe('push command dry-run outlet', () => {
  let dir;
  let auditPath;
  let logSpy;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-dry-run-'));
    auditPath = path.join(dir, 'audit.jsonl');
    cliConfig.get.mockReset();
    cliConfig.getDataDir.mockReset().mockReturnValue(dir);
    meridian.init.mockReset();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('registers dry-run options and avoids server config/network outlet', async () => {
    const kb = {
      getEntry: jest.fn(() => ({
        schemaVersion: '4.0',
        id: 'entry-dry-run',
        name: 'Reviewed local note',
        description: 'Reviewed local Recall note.',
        status: 'active',
        category: 'summary',
        projectId: 'recall-local',
        source: 'local-review',
        partition: 'trusted_kb',
        source_trust_level: 'trusted',
        content_hash: `sha256:${'a'.repeat(64)}`,
      })),
      close: jest.fn(),
    };
    meridian.init.mockReturnValue(kb);

    const { action, chain } = capturePushAction();

    await action('recall-local', 'entry-dry-run', { dryRun: true, auditPath });

    expect(chain.option).toHaveBeenCalledWith('--dry-run', expect.any(String));
    expect(chain.option).toHaveBeenCalledWith('--audit-path <path>', expect.any(String));
    expect(cliConfig.get).not.toHaveBeenCalledWith('serverUrl');
    expect(cliConfig.get).not.toHaveBeenCalledWith('apiKey');
    expect(kb.getEntry).toHaveBeenCalledWith('recall-local', 'entry-dry-run');
    expect(kb.close).toHaveBeenCalled();
    expect(readAuditEvents(auditPath)).toHaveLength(1);
  });
});
