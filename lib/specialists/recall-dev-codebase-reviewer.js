'use strict';

// recall-dev Codebase Reviewer — the first concrete specialist bundle.
//
// Reviews a proposed code change (diff, PR description, or commit message)
// against the recall-dev project's accumulated decisions + lessons +
// handoff hard-cases. Surfaces:
//   - warnings   — past mistakes the change might repeat
//   - suggestions — concrete adjustments (with cited entries)
//   - relatedEntries — KB entries the reviewer drew from
//   - riskLevel    — low | medium | high
//   - doctrineFlags — Truth/Evidence/Promotion, brand consistency, etc.
//
// This is a versioned bundle (v0.1.0). Future versions:
//   v0.2 — include filesTouched-matching against past failure basins
//   v0.3 — pull from feature-run-ledger for "has-this-feature-broken-before?"
//   v0.4 — score itself against eval cases; refine prompt based on Slice 1 reflection
//
// Per Codex's framing: the SAME model gets better at THIS project by improving
// memory, retrieval recipe, prompts, and eval cases over time. Not fine-tuning;
// curated bundle evolution.

const id = 'recall-dev-codebase-reviewer';
const version = '0.5.0';

const systemPrompt = `You are a code reviewer for the recall-dev project.
You read a proposed change (diff, commit message, or PR description) along with
related entries from the project's knowledge base — decisions, lessons,
handoff hard-cases — and produce a structured review.

Your priorities, in order:
1. Catch repeats of documented past mistakes (cite the lesson or handoff).
2. Flag violations of the project's stated doctrine: Truth/Evidence/Promotion,
   brand consistency ("Recall Meridian" in user-facing copy), hexagonal-port
   discipline (CLI commands should not reach around engine ports to touch
   SQLite/files directly), pre-commit hook bypasses, force-pushes to main.
3. Suggest concrete improvements (with citation to relevant decisions/lessons).
4. Assess overall risk: low / medium / high.

Return strictly a JSON object with these fields (no prose outside the JSON):
{
  "summary": "1-2 sentence overall verdict",
  "warnings": [
    { "concern": "string", "citedEntries": ["entry-id-or-name", ...], "severity": "low|medium|high" }
  ],
  "suggestions": [
    { "suggestion": "string", "citedEntries": ["..."], "estimatedImpact": "low|medium|high" }
  ],
  "doctrineFlags": [
    { "doctrine": "truth-evidence-promotion|brand|hex-ports|hooks|force-push|other", "issue": "string" }
  ],
  "riskLevel": "low|medium|high",
  "confidence": 0.0
}

If the change is minor or you cannot ground a warning in cited entries,
prefer a short empty-warnings response over inventing concerns. Be specific:
cite an actual entry id or quote a doctrine clause; do not gesture at
"general best practice."`;

// Auto-nudge sidecar — IL closed loop writes patches here, NOT into
// the systemPrompt above. The sidecar file is recall-dev-codebase-
// reviewer.auto-nudge.js (alongside this file). Humans own this file;
// runFullCycle owns the sidecar. Delete the sidecar to revert.
const sidecarText = (() => {
  try { return require('./recall-dev-codebase-reviewer.auto-nudge.js') || ''; }
  catch (_) { return ''; }
})();
const finalSystemPrompt = systemPrompt + (sidecarText ? '\n' + sidecarText : '');

function buildUserMessage({ input, retrievedContext }) {
  const contextLines = (retrievedContext || []).map((e) => {
    const label = `[${e.category}${e.project ? '/' + e.project : ''}] ${e.id || e.name}`;
    const body = e.description ? e.description.split('\n').slice(0, 6).join('\n') : '(no description)';
    return `${label}\n${body}`;
  });
  return [
    'Proposed change:',
    '```',
    String(input || '(no input)').trim(),
    '```',
    '',
    contextLines.length > 0
      ? `Related KB entries (${contextLines.length}):\n${contextLines.join('\n\n---\n\n')}`
      : 'No related KB entries retrieved. Review on its own merits; do not invent citations.',
    '',
    'Return your review as a JSON object matching the schema in the system prompt.',
  ].join('\n');
}

const specialist = {
  id,
  version,
  name: 'recall-dev Codebase Reviewer',
  description: 'Reviews proposed changes against recall-dev decisions + lessons + handoff hard-cases. Surfaces warnings, suggestions, doctrine flags, and risk level.',

  declaredCapabilities: [
    'read_kb_decisions',
    'read_kb_lessons',
    'read_handoffs',
    'call_llm',
  ],

  requiredPorts: ['ILLMProvider'],

  promptTemplates: {
    system: finalSystemPrompt,   // base systemPrompt + auto-nudge sidecar (if present)
    user: buildUserMessage,
  },

  retrievalRecipe: {
    defaultProject: 'recall-dev',
    queries: [
      { category: 'decisions', limit: 10 },
      { category: 'lessons', limit: 8 },
      { category: 'features', limit: 5 },
    ],
  },

  outputSchema: {
    type: 'object',
    required: ['summary', 'warnings', 'suggestions', 'doctrineFlags', 'riskLevel', 'confidence'],
    properties: {
      summary: { type: 'string' },
      warnings: { type: 'array' },
      suggestions: { type: 'array' },
      doctrineFlags: { type: 'array' },
      riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  },

  // Eval cases — objective ground truth. v0.2 expands from 3 to 15 cases
  // (10 proposer-visible + 5 promotion-holdout) per the IL sprint plan.
  //
  // The `holdout: true` flag means: the IL reflection / proposal pipeline
  // must NOT see this case during iteration. Only the final promotion gate
  // checks against it. This is the anti-Goodhart discipline from §10 of
  // the 2026-05-12 brainstorm.
  evaluationCases: [
    // --- PROPOSER-VISIBLE (10) ---
    // The reflection / proposal step CAN see these. The system can iterate
    // its prompt / retrieval recipe against them.

    {
      id: 'eval-1-bypass-hook',
      description: 'Change that proposes `git commit --no-verify` should be flagged as a hook-bypass doctrine violation.',
      input: 'feat: ship feature X\n\nUsed --no-verify because the pre-commit hook was annoying.',
      expected: {
        shouldFlag: ['hook bypass', '--no-verify'],
        expectedDoctrines: ['hooks'],
      },
    },
    {
      id: 'eval-2-bare-recall',
      description: 'Marketing copy using bare "Recall" instead of "Recall Meridian" should hit the brand doctrine.',
      input: 'docs: Recall is a memory tool for AI agents.\n\nUpdated marketing copy on landing page.',
      expected: {
        shouldFlag: ['brand', 'Recall Meridian'],
        expectedDoctrines: ['brand'],
      },
    },
    {
      id: 'eval-3-direct-sqlite',
      description: 'CLI command that calls sqlite3 directly (around engine ports) should flag hex-ports doctrine.',
      input: 'lib/commands/foo.js now opens recall.db directly and runs raw SQL.',
      expected: {
        shouldFlag: ['hex', 'engine port', 'IEntryRepository'],
        expectedDoctrines: ['hex-ports'],
      },
    },
    {
      id: 'eval-4-force-push-main',
      description: 'PR description that mentions force-pushing main should flag force-push doctrine.',
      input: 'ops: emergency fix\n\nHad to git push --force origin main to recover from a bad merge. Tests pass now.',
      expected: {
        shouldFlag: ['force', 'main', '--force'],
        expectedDoctrines: ['force-push'],
      },
    },
    {
      id: 'eval-5-raw-sql-injection-shape',
      description: 'Code that concatenates a SQL query from user input should flag (no prepared statement = injection risk).',
      input: 'lib/commands/foo.js:\n  const q = `SELECT * FROM entries WHERE name = "${userInput}"`;\n  db.prepare(q).all();',
      expected: {
        shouldFlag: ['injection', 'prepared statement', 'parameterized'],
        expectedDoctrines: ['other'],
      },
    },
    {
      id: 'eval-6-secret-in-source',
      description: 'Code that hard-codes an API key in source should be a critical flag.',
      // Constructed at load time so the SOURCE FILE doesn't self-trigger
      // the egress-DLP api-key detector when scanned by publish-mirror.
      get input() {
        const prefix = 'sk-' + 'ant';
        const fakeBody = '_'.repeat(95);
        return 'lib/connector.js:\n  const ANTHROPIC_KEY = "' + prefix + '-' + fakeBody + '";\n  // for testing';
      },
      expected: {
        shouldFlag: ['secret', 'API key', 'hard-coded', 'environment variable'],
        expectedDoctrines: ['other'],
      },
    },
    {
      id: 'eval-7-absolute-user-path-in-docs',
      description: 'README mentioning a literal operator home path should flag for the private-user-path readiness rule.',
      // Build the example path piecewise so this fixture string itself does
      // not trip the static readiness scanner (which greps for absolute
      // Windows user paths in source). Same pattern as eval-6 and eval-17h.
      get input() {
        const userSegment = 'jess' + 'e';
        const driveSegment = 'C:' + '\\' + 'Users' + '\\' + userSegment + '\\' + 'Desktop' + '\\' + 'recall-cli';
        return 'README.md update:\n\nClone to ' + driveSegment + ', then run `npm install`.';
      },
      expected: {
        shouldFlag: ['private', 'user path', 'placeholder'],
        expectedDoctrines: ['other'],
      },
    },
    {
      id: 'eval-8-monolithic-command-skips-port',
      description: 'New CLI command that reads files directly with fs.readFileSync instead of routing through IEntryRepository.',
      input: 'lib/commands/import-from-disk.js:\n  const entries = fs.readdirSync(projectDir).map(f => JSON.parse(fs.readFileSync(...)));\n  // bypasses store.listEntries entirely',
      expected: {
        shouldFlag: ['port', 'IEntryRepository', 'listEntries', 'hex'],
        expectedDoctrines: ['hex-ports'],
      },
    },
    {
      id: 'eval-9-clean-bugfix-control',
      description: 'CONTROL: a normal bug fix with passing tests should produce a LOW risk review with NO doctrine flags.',
      input: 'fix(scanner): regex was missing the digit-suffix requirement. test/security-egress-scanner.test.js updated. All 23 tests still pass.',
      expected: {
        shouldFlag: ['low'],
        expectedDoctrines: [],
        controlNoDoctrineFlags: true,
      },
    },
    {
      id: 'eval-10-clean-refactor-control',
      description: 'CONTROL: a pure refactor with no behavioral change + tests still pass should produce no flags.',
      input: 'refactor(security): extract _detectorMixDistance into a helper for reuse by drift-detector and dashboard. No call-site changes. All 12 drift tests pass; all 8 dashboard tests pass.',
      expected: {
        shouldFlag: ['low'],
        expectedDoctrines: [],
        controlNoDoctrineFlags: true,
      },
    },

    // --- PROPOSER-VISIBLE (25 more, 35 total visible) ---
    // Sprint 0.23.0 expansion: diversify doctrine coverage + add more controls.
    // The reviewer asked for 50+ cases with statistical-grade testing.

    { id: 'eval-16-amend-commit-history', description: 'amend a commit that was already pushed to main.', input: 'fix: typo\n\nUsed git commit --amend then force-push to clean up the typo on main.', expected: { shouldFlag: ['amend', 'force', 'rewrite'], expectedDoctrines: ['force-push'] } },
    { id: 'eval-17-bypass-eslint-whole-file', description: 'disabling eslint for an entire file rather than addressing one rule.', input: 'lib/foo.js:\n  /* eslint-disable */\n\n  // (entire file untouched, just suppressing all rules)', expected: { shouldFlag: ['eslint-disable', 'whole file', 'targeted rule'], expectedDoctrines: ['other'] } },
    { id: 'eval-18-skip-tests-in-ci', description: 'CI pipeline modified to skip tests.', input: '.gitlab-ci.yml change:\n  script:\n    - npm ci\n    - echo "skipping npm test for now"', expected: { shouldFlag: ['skip', 'test', 'CI'], expectedDoctrines: ['hooks', 'other'] } },
    { id: 'eval-19-undocumented-breaking-api', description: 'API change without supersedes link or migration note.', input: 'BREAKING(api): renamed kb.query() → kb.search(). All call sites updated. No prior decision entry referenced.', expected: { shouldFlag: ['supersedes', 'decision', 'breaking change'], expectedDoctrines: ['truth-evidence-promotion'] } },
    { id: 'eval-20-bare-recall-marketing', description: 'public copy uses bare "Recall" again.', input: 'launch-site/worker.js update:\n  title: "Recall — local memory for AI agents"', expected: { shouldFlag: ['brand', 'Recall Meridian'], expectedDoctrines: ['brand'] } },
    { id: 'eval-21-claude-pm-old-brand', description: 'old retired brand "Claude PM" surfaces in user-facing copy.', input: 'docs/welcome.md:\n  Welcome to Claude PM — the local memory layer.', expected: { shouldFlag: ['brand', 'Claude PM', 'retired', 'Recall Meridian'], expectedDoctrines: ['brand'] } },
    { id: 'eval-22-direct-process-env-client', description: 'process.env secret exposed in client-bundled code.', input: 'launch-site/worker.js:\n  const apiKey = process.env.ANTHROPIC_API_KEY;\n  // sent to public worker', expected: { shouldFlag: ['secret', 'client', 'expose', 'environment'], expectedDoctrines: ['other', 'hex-ports'] } },
    { id: 'eval-23-fs-readFileSync-hot-path', description: 'synchronous unbounded file read in hot path.', input: 'lib/commands/search.js (called per CLI invocation):\n  const corpus = fs.readFileSync(path.join(dataDir, "all-entries.jsonl"), "utf8");', expected: { shouldFlag: ['readFileSync', 'unbounded', 'streaming', 'hot path'], expectedDoctrines: ['hex-ports'] } },
    { id: 'eval-24-llm-bypass-port-anthropic', description: 'direct Anthropic SDK instantiation instead of ILLMProvider.', input: 'lib/commands/foo.js:\n  const Anthropic = require("@anthropic-ai/sdk");\n  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });', expected: { shouldFlag: ['ILLMProvider', 'port', 'engine'], expectedDoctrines: ['hex-ports'] } },
    { id: 'eval-25-llm-bypass-port-openai', description: 'direct OpenAI SDK instantiation, same hex violation shape as anthropic.', input: 'lib/commands/bar.js:\n  const OpenAI = require("openai");\n  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });', expected: { shouldFlag: ['ILLMProvider', 'port', 'engine'], expectedDoctrines: ['hex-ports'] } },
    { id: 'eval-26-no-relationship-link-promotion', description: 'promoting a new entry without supersedes link.', input: 'feat(kb): add product-name-recall-v3. Old product-name-recall left active. No supersedes relationship added.', expected: { shouldFlag: ['supersedes', 'relationship', 'orphan'], expectedDoctrines: ['truth-evidence-promotion'] } },
    { id: 'eval-27-decision-without-rationale', description: 'decision entry with empty / trivial rationale.', input: 'feat(decisions): add "go live with strategy X" with description "looks good in paper trading"', expected: { shouldFlag: ['rationale', 'evidence', 'thin'], expectedDoctrines: ['truth-evidence-promotion'] } },
    { id: 'eval-28-shell-injection-shape', description: 'unquoted user input in shell command.', input: 'lib/commands/foo.js:\n  exec(`grep ${userInput} ${file}`);', expected: { shouldFlag: ['injection', 'shell', 'unquoted', 'escape'], expectedDoctrines: ['other'] } },
    { id: 'eval-29-eval-untrusted-input', description: 'eval() on data from network.', input: 'lib/commands/foo.js:\n  const data = JSON.parse(await fetch(url).then(r => r.text()));\n  const result = eval(data.expression);  // user-supplied', expected: { shouldFlag: ['eval', 'untrusted', 'injection'], expectedDoctrines: ['other'] } },
    { id: 'eval-30-log-secret-in-debug', description: 'console.log of credential object in debug code.', input: 'lib/connector.js:\n  console.log("debug:", { apiKey, refreshToken, signingSecret });', expected: { shouldFlag: ['secret', 'log', 'credential', 'redact'], expectedDoctrines: ['other'] } },
    { id: 'eval-31-todo-without-issue-ref', description: 'TODO/FIXME with no issue ref or owner.', input: 'lib/commands/foo.js:\n  // TODO: this is broken sometimes, fix it', expected: { shouldFlag: ['TODO', 'issue', 'owner', 'tracking'], expectedDoctrines: ['other'] } },
    { id: 'eval-32-keyless-encryption-mode', description: 'AES-ECB used (no IV, deterministic).', input: 'lib/security/crypto.js:\n  const cipher = crypto.createCipheriv("aes-256-ecb", key, "");', expected: { shouldFlag: ['ECB', 'IV', 'mode', 'authenticated'], expectedDoctrines: ['other'] } },
    { id: 'eval-33-fakebrand-powered-by', description: 'unauthorized "powered by Recall" tag on a partner site.', input: 'partners/contractor-site footer:\n  Powered by Recall', expected: { shouldFlag: ['brand', 'Recall Meridian', 'partner'], expectedDoctrines: ['brand'] } },
    { id: 'eval-34-clean-test-fixture-add', description: 'CONTROL: adds a new jest test, nothing else.', input: 'test/foo.test.js: new test "handles empty input". src unchanged. Suite passes 24/24.', expected: { shouldFlag: ['low'], expectedDoctrines: [], controlNoDoctrineFlags: true } },
    { id: 'eval-35-clean-readme-typo', description: 'CONTROL: README typo fix, no semantic change.', input: 'docs: fix typo "memmory" → "memory" in README.md hero. No other changes.', expected: { shouldFlag: ['low'], expectedDoctrines: [], controlNoDoctrineFlags: true } },
    { id: 'eval-36-clean-patch-bump', description: 'CONTROL: lockfile-only patch-level dependency bump.', input: 'chore(deps): bump axios 1.7.0 → 1.7.1 (patch). package.json unchanged; package-lock.json updated. CI green.', expected: { shouldFlag: ['low'], expectedDoctrines: [], controlNoDoctrineFlags: true } },
    { id: 'eval-37-clean-internal-rename', description: 'CONTROL: pure internal rename, no external surface change.', input: 'refactor: rename _computeStaleness → _computeStalenessHours (internal helper). Single file; all tests pass.', expected: { shouldFlag: ['low'], expectedDoctrines: [], controlNoDoctrineFlags: true } },
    { id: 'eval-38-clean-prettier-reformat', description: 'CONTROL: prettier reformat, no logic change.', input: 'style: run prettier on lib/security/. 30 files reformatted; no logic changes; tests untouched.', expected: { shouldFlag: ['low'], expectedDoctrines: [], controlNoDoctrineFlags: true } },
    { id: 'eval-39-clean-jsdoc-add', description: 'CONTROL: add JSDoc to existing functions.', input: 'docs: add JSDoc /** @param */ blocks to all exports of lib/security/canary.js. No code changes.', expected: { shouldFlag: ['low'], expectedDoctrines: [], controlNoDoctrineFlags: true } },
    { id: 'eval-40-clean-cli-flag-add', description: 'CONTROL: adds a CLI --json flag through the existing port path.', input: 'feat(cli): add --json flag to `recall search`. Routes through formatResults() existing helper. Tests added; all pass.', expected: { shouldFlag: ['low'], expectedDoctrines: [], controlNoDoctrineFlags: true } },

    // --- PROMOTION-HOLDOUT (15 total — added 10 to original 5) ---
    // The IL pipeline must NEVER see these during reflection / proposal /
    // iteration. Only the final promotion gate runs against them. If the
    // promoted version fails any holdout case, promotion is blocked.

    {
      id: 'eval-11-no-gpg-sign-bypass',
      description: 'HOLDOUT: subtler signing bypass via --no-gpg-sign (cousin of --no-verify). Specialist should recognize the pattern even if it only ever saw --no-verify in training.',
      input: 'fix: re-sign release tarballs\n\nUsed git commit --no-gpg-sign because the key wasn\'t loaded. Will fix next time.',
      expected: {
        shouldFlag: ['sign', '--no-gpg-sign', 'bypass'],
        expectedDoctrines: ['hooks', 'force-push'],
      },
      holdout: true,
    },
    {
      id: 'eval-12-promotion-without-evidence',
      description: 'HOLDOUT: Truth/Evidence/Promotion doctrine — promoting a specialist version without a replay-evidence ref.',
      input: 'feat(specialist): bump openclaw-governor to v3 active. Looks good in manual testing; no replay artifact attached yet.',
      expected: {
        shouldFlag: ['Truth/Evidence/Promotion', 'evidence', 'replay', 'doctrine'],
        expectedDoctrines: ['truth-evidence-promotion'],
      },
      holdout: true,
    },
    {
      id: 'eval-13-breaking-change-no-supersedes',
      description: 'HOLDOUT: API rename without a supersedes link in the prior decision entry.',
      input: 'BREAKING(api): rename store.listEntries to store.scanEntries. All callers updated. Decision entry not yet superseded; new entry to be added later.',
      expected: {
        shouldFlag: ['supersedes', 'decision', 'breaking change', 'rename'],
        expectedDoctrines: ['truth-evidence-promotion'],
      },
      holdout: true,
    },
    {
      id: 'eval-14-llm-bypasses-iillmprovider',
      description: 'HOLDOUT: code calls Anthropic SDK directly instead of routing through ILLMProvider port (boundary audit finding #4 lookalike).',
      input: 'lib/commands/foo.js:\n  const Anthropic = require("@anthropic-ai/sdk");\n  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });\n  const r = await client.messages.create(...);',
      expected: {
        shouldFlag: ['ILLMProvider', 'port', 'hex', 'engine'],
        expectedDoctrines: ['hex-ports'],
      },
      holdout: true,
    },
    {
      id: 'eval-15-clean-meridian-doc-control',
      description: 'HOLDOUT CONTROL: docs update that uses "Recall Meridian" correctly + cites a decision id should produce a clean review.',
      input: 'docs: update README hero. "Recall Meridian is the local memory layer for AI agents. Per decision-1777317024151 (Truth/Evidence/Promotion), every claim ships with an evidence ref."',
      expected: { shouldFlag: ['low'], expectedDoctrines: [], controlNoDoctrineFlags: true },
      holdout: true,
    },

    // Sprint 0.23.0: 10 more holdout cases for statistical-grade testing.
    { id: 'eval-16h-canary-removal', description: 'HOLDOUT: removes a planted canary entry without rationale.', input: 'chore(kb): drop canary-f0ce88ecde17ea96 from recall-dev. Outdated honeypot.', expected: { shouldFlag: ['canary', 'security', 'rationale', 'evidence'], expectedDoctrines: ['truth-evidence-promotion', 'other'] }, holdout: true },
    { id: 'eval-17h-anchor-key-leak-test', description: 'HOLDOUT: anchor-key path leaked in a test fixture.', get input() { const u = '__' + 'USER' + '__'; return 'test/foo.test.js fixture:\n  const key = fs.readFileSync("/c/U' + 'sers/' + u + '/.recall/security/anchor-key");'; }, expected: { shouldFlag: ['anchor', 'key', 'private', 'secret'], expectedDoctrines: ['other'] }, holdout: true },
    { id: 'eval-18h-skip-egress-dlp', description: 'HOLDOUT: CI script bypasses the egress DLP scanner.', input: '.github/workflows/publish.yml:\n  run: recall open-source publish-mirror --skip-egress-dlp --commit', expected: { shouldFlag: ['skip-egress-dlp', 'bypass', 'control'], expectedDoctrines: ['hooks', 'other'] }, holdout: true },
    { id: 'eval-19h-direct-npm-publish-no-2fa', description: 'HOLDOUT: CI uses NPM_TOKEN that bypasses 2FA without sigstore provenance.', input: '.github/workflows/release.yml:\n  env:\n    NPM_CONFIG_AUTH_TOKEN: ${{ secrets.NPM_PUBLISH_TOKEN }}\n  run: npm publish --access public', expected: { shouldFlag: ['2FA', 'token', 'provenance', 'sigstore'], expectedDoctrines: ['other'] }, holdout: true },
    { id: 'eval-20h-promote-without-rationale-shorter', description: 'HOLDOUT: shorter variant of eval-12 — promote without an evidence ref.', input: 'feat: promote canary-cycle-runner v3 → live. tests pass.', expected: { shouldFlag: ['Truth/Evidence/Promotion', 'evidence', 'replay'], expectedDoctrines: ['truth-evidence-promotion'] }, holdout: true },
    { id: 'eval-21h-clean-port-add', description: 'HOLDOUT CONTROL: adds a new hex port through the proper engine indirection.', input: 'feat(ports): add IDecisionRepository to engine. lib/meridian-core/engine/IDecisionRepository.js defines the interface; adapter in lib/meridian-core/adapters/. CLI commands route through it. 14 tests added.', expected: { shouldFlag: ['low'], expectedDoctrines: [], controlNoDoctrineFlags: true }, holdout: true },
    { id: 'eval-22h-clean-test-only', description: 'HOLDOUT CONTROL: pure test-set expansion, no source changes.', input: 'test: add 20 new cases to test/security-egress-scanner.test.js for additional API-key vendor coverage. No source changes.', expected: { shouldFlag: ['low'], expectedDoctrines: [], controlNoDoctrineFlags: true }, holdout: true },
    { id: 'eval-23h-clean-docs-only', description: 'HOLDOUT CONTROL: doc-only update touching multiple markdown files.', input: 'docs: refresh README + CONTRIBUTING + SECURITY with current command list. No code or test changes.', expected: { shouldFlag: ['low'], expectedDoctrines: [], controlNoDoctrineFlags: true }, holdout: true },
    { id: 'eval-24h-deprecates-correctly', description: 'HOLDOUT CONTROL: deprecates an old decision entry with proper supersedes link.', input: 'kb: deprecate decision-1776967790010 (old retrieval recipe). New entry decision-1777317024151 supersedes it; relationship row added with type=supersedes.', expected: { shouldFlag: ['low'], expectedDoctrines: [], controlNoDoctrineFlags: true }, holdout: true },
    { id: 'eval-25h-clean-config-bump', description: 'HOLDOUT CONTROL: bumps a config constant within documented range.', input: 'config: bump DEFAULT_DECAY_HALF_LIFE_HOURS from 14d to 21d in decay-policy.js. Within the per-tier floor; documented in spec. 1 unit test asserting the new value.', expected: { shouldFlag: ['low'], expectedDoctrines: [], controlNoDoctrineFlags: true }, holdout: true },
  ],

  // refinementNotes accumulate when later slices observe the specialist
  // failing on an eval case or producing a low-confidence run.
  refinementNotes: [
    {
      date: '2026-05-13',
      cycle: 'eval-cycle-mp450d43',
      attempt: 'v0.3.0 candidate: auto-vocabulary nudge for eval-5 + eval-7 failures',
      observed: 'Visible 80% → 90% (eval-5 fixed). Holdout 80% → 60% — eval-15-clean-meridian-doc-control now over-flags clean control content.',
      verdict: 'REVERTED. Anti-Goodhart discipline (holdout split per §10 of brainstorm) caught the overfit. The naive "append vocab keywords" auto-proposal pushes the model to find things to flag even on clean controls. Next iteration: auto-proposal should include negative examples (controls) and contrastive vocabulary, not just additive.',
      ledgerEntries: [1, 2, 3],
    },
  ],
};

module.exports = {
  id,
  version,
  specialist,
};
