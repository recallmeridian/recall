'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const meridian = require('../lib/meridian-core');
const historyImport = require('../lib/history-import');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-history-import-'));
}

describe('history import port', () => {
  let dir;
  let kb;

  beforeEach(() => {
    dir = tempDir();
    kb = meridian.init(dir);
  });

  afterEach(() => {
    if (kb) kb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('parses Claude.ai conversations into normalized records', () => {
    const exportPath = path.join(dir, 'conversations.json');
    fs.writeFileSync(exportPath, JSON.stringify([
      {
        uuid: 'abc',
        name: 'Recall importer',
        created_at: '2026-04-29T12:00:00Z',
        chat_messages: [
          { sender: 'human', text: 'We need to implement a history import port.' },
          { sender: 'assistant', text: 'Decision: use ports and adapters. TODO add tests.' },
        ],
      },
    ]));

    const records = historyImport.parseClaudeAiExport(exportPath);

    expect(records).toHaveLength(1);
    expect(records[0].source).toBe('claude-ai');
    expect(records[0].kind).toBe('ai_chat');
    expect(records[0].messageCount).toBe(2);
    expect(records[0].todos.length).toBeGreaterThan(0);
    expect(records[0].decisions.length).toBeGreaterThan(0);
  });

  test('imports records as draft evidence and deduplicates by hash', () => {
    const record = historyImport.normalizeRecord({
      source: 'codex',
      kind: 'coding_session',
      sourcePath: path.join(dir, 'session.jsonl'),
      title: 'Codex session',
      text: 'TODO wire import-history into startup.',
      projectHint: 'recall-cli',
    });

    const first = historyImport.importRecords(kb, historyImport.DEFAULT_PROJECT, [record]);
    const second = historyImport.importRecords(kb, historyImport.DEFAULT_PROJECT, [record]);

    expect(first.created).toHaveLength(1);
    expect(first.created[0].status).toBe('draft');
    expect(first.created[0].category).toBe('history-evidence');
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toHaveLength(1);
  });

  test('analyzes imported evidence into draft project reconstructions', () => {
    const records = [
      historyImport.normalizeRecord({
        source: 'codex',
        kind: 'coding_session',
        sourcePath: path.join(dir, 'a.jsonl'),
        title: 'Recall session',
        text: 'Decision: imported chats are evidence not truth. TODO build review gate.',
        projectHint: 'recall-cli',
      }),
      historyImport.normalizeRecord({
        source: 'repo',
        kind: 'repository_snapshot',
        sourcePath: dir,
        title: 'Repository snapshot',
        text: 'Recall CLI README import-history project reconstruction.',
        projectHint: 'recall-cli',
      }),
    ];
    historyImport.importRecords(kb, historyImport.DEFAULT_PROJECT, records);

    const summaries = historyImport.analyzeProject(kb, historyImport.DEFAULT_PROJECT);
    const entries = kb.listEntries(historyImport.DEFAULT_PROJECT, { category: 'project-reconstruction' });

    expect(summaries).toHaveLength(1);
    expect(summaries[0].projectKey).toBe('recall-cli');
    expect(summaries[0].evidenceCount).toBe(2);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('draft');
    expect(entries[0]._extensions.promotionState).toBe('review');
  });

  test('promotes only project reconstruction analysis entries', () => {
    const record = historyImport.normalizeRecord({
      source: 'codex',
      kind: 'coding_session',
      sourcePath: path.join(dir, 'a.jsonl'),
      title: 'Recall session',
      text: 'TODO promote after review.',
      projectHint: 'recall-cli',
    });
    historyImport.importRecords(kb, historyImport.DEFAULT_PROJECT, [record]);
    historyImport.analyzeProject(kb, historyImport.DEFAULT_PROJECT);

    const promoted = historyImport.promoteAnalysis(kb, historyImport.DEFAULT_PROJECT, 'analysis-recall-cli');

    expect(promoted.status).toBe('active');
    expect(promoted.confidence.value).toBeGreaterThan(0.6);
    expect(promoted._extensions.promotionState).toBe('promoted');
    expect(() => historyImport.promoteAnalysis(kb, historyImport.DEFAULT_PROJECT, `evidence-codex-${record.hash.slice(0, 12)}`)).toThrow(/not a project reconstruction/);
  });

  test('finds multiple git repositories below a parent folder', () => {
    const root = path.join(dir, 'projects');
    const one = path.join(root, 'alpha');
    const two = path.join(root, 'nested', 'beta');
    fs.mkdirSync(path.join(one, '.git'), { recursive: true });
    fs.mkdirSync(path.join(two, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'not-a-repo'), { recursive: true });

    const repos = historyImport.findGitRepos(root);

    expect(repos).toEqual([one, two].sort());
  });
});
