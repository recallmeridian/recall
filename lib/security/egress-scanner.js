'use strict';

// Egress DLP scanner — pure function that classifies outbound content.
//
// Slice #2 of Codex's 5-slice OpenClaw build order from the 2026-05-12
// security brainstorm. Built as a Recall feature first, wired into the
// publish-mirror command second, so it's a control (not a primitive)
// per the brainstorm's §13.2 doctrine.
//
// Detector taxonomy (severity-ranked):
//
//   high   — block the action. Examples: API keys, server IPs, env-files,
//            absolute home paths, raw-memory dumps.
//   medium — review. Examples: long base64 blobs, project names that look
//            private, KB entry IDs that may be private references.
//   low    — warn only. Examples: private RFC1918 IPs, file path mentions
//            without absolute root.
//
// Verdict aggregation:
//   - any high  -> decision = 'block'
//   - any medium AND no high -> decision = 'review'
//   - low only  -> decision = 'allow' (warnings still surfaced)
//   - none      -> decision = 'allow'
//
// The scanner never logs raw content — it returns offsets and a sha256
// content hash so the ledger has provenance without leaking the secret.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Operator-specific watchlists are loaded at runtime from a config file
// outside the source tree, so the shipped scanner ships clean. Each
// operator populates ~/.recall/security/scanner-config.json with their
// own server IPs, private project directory names, etc. If the file is
// missing, only the universal detectors (API keys, paths, PEM blocks,
// JWT, etc.) fire.
//
// Config schema:
//   {
//     "privateOperatorIps":  ["1.2.3.4", "5.6.7.8"],
//     "privateProjectDirs":  ["my-private-project", "another-private-dir"]
//   }

function loadOperatorConfig() {
  const configPath = path.join(os.homedir(), '.recall', 'security', 'scanner-config.json');
  if (!fs.existsSync(configPath)) return { privateOperatorIps: [], privateProjectDirs: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return {
      privateOperatorIps: Array.isArray(raw.privateOperatorIps) ? raw.privateOperatorIps : [],
      privateProjectDirs: Array.isArray(raw.privateProjectDirs) ? raw.privateProjectDirs : [],
    };
  } catch (_) {
    return { privateOperatorIps: [], privateProjectDirs: [] };
  }
}

const OPERATOR_CONFIG = loadOperatorConfig();
const PRIVATE_OPERATOR_IPS = OPERATOR_CONFIG.privateOperatorIps;
const PRIVATE_PROJECT_DIRS = OPERATOR_CONFIG.privateProjectDirs;

const DETECTORS = [
  {
    id: 'anthropic-api-key',
    severity: 'high',
    re: /sk-ant-[a-zA-Z0-9_-]{40,}/g,
    label: 'Anthropic API key',
  },
  {
    id: 'openai-api-key',
    severity: 'high',
    re: /\bsk-(?:proj-)?[a-zA-Z0-9_-]{32,}/g,
    label: 'OpenAI API key',
  },
  {
    id: 'aws-access-key',
    severity: 'high',
    re: /\bAKIA[A-Z0-9]{16}\b/g,
    label: 'AWS access key',
  },
  {
    id: 'github-token',
    severity: 'high',
    re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
    label: 'GitHub token',
  },
  {
    id: 'google-api-key',
    severity: 'high',
    re: /\bAIza[A-Za-z0-9_\-]{35}\b/g,
    label: 'Google API key',
  },
  {
    id: 'slack-token',
    severity: 'high',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    label: 'Slack token',
  },
  {
    id: 'stripe-secret',
    severity: 'high',
    re: /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/g,
    label: 'Stripe secret key',
  },
  {
    id: 'moltbook-api-key',
    severity: 'high',
    re: /\bmoltbook_sk_[A-Za-z0-9_-]{20,}\b/g,
    label: 'Moltbook API key',
  },
  {
    id: 'private-key-pem',
    severity: 'high',
    re: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED |)PRIVATE KEY-----/g,
    label: 'Private key (PEM block)',
  },
  {
    id: 'env-credential-line',
    severity: 'high',
    // Match (case-insensitive) credential-shaped env vars where the
    // var name CONTAINS one of the credential keywords (anywhere in
    // the name) and is assigned a long token. Examples we must match:
    //   API_KEY=..., API_TOKEN=..., SECRET_KEY=..., AUTH_TOKEN=...,
    //   DB_PASSWORD=..., CLIENT_SECRET=..., BEARER_AUTH=...
    // The keyword can appear at start, end, or middle of the var name.
    // Non-letter boundary before the var name avoids matching inside
    // unrelated identifiers; underscores count as non-letter so
    // OPENAI_API_KEY matches.
    // Require at least one digit in the value's first 16 chars — real
    // keys/tokens always contain digits, while JS identifier-style
    // assignments like `tokenFingerprint = otherIdentifier` do not.
    // This eliminates the most common false-positive shape.
    re: /(?:^|[^A-Za-z])[A-Z_]*(?:PASSWORD|SECRET|TOKEN|API[_-]?KEY|API[_-]?TOKEN|ACCESS[_-]?KEY|AUTH[_-]?TOKEN|CLIENT[_-]?SECRET|BEARER|CREDENTIAL)[A-Z_]*\s*[:=]\s*["']?(?=[A-Za-z0-9_\-]{16,})(?=[A-Za-z0-9_\-]*\d)[A-Za-z0-9_\-]{16,}/gi,
    label: 'Credential-shaped env assignment',
  },
  {
    id: 'absolute-windows-user-path',
    severity: 'high',
    re: /\b[A-Z]:\\Users\\[^\s'"`<>|*?]+/g,
    label: 'Absolute Windows user path',
  },
  {
    id: 'absolute-mac-user-path',
    severity: 'high',
    re: /\/Users\/[a-zA-Z0-9._-]+\/[^\s'"`<>|*?]+/g,
    label: 'Absolute macOS user path',
  },
  {
    id: 'absolute-linux-home-path',
    severity: 'high',
    re: /\/home\/[a-zA-Z0-9._-]+\/[^\s'"`<>|*?]+/g,
    label: 'Absolute Linux home path',
  },
  ...(PRIVATE_OPERATOR_IPS.length > 0 ? [{
    id: 'private-operator-ip',
    severity: 'high',
    re: new RegExp(`\\b(?:${PRIVATE_OPERATOR_IPS.map(ip => ip.replace(/\./g, '\\.')).join('|')})\\b`, 'g'),
    label: 'Operator server IP (private infrastructure)',
  }] : []),
  ...(PRIVATE_PROJECT_DIRS.length > 0 ? [{
    id: 'private-project-dir',
    severity: 'medium',
    re: new RegExp(`\\b(?:${PRIVATE_PROJECT_DIRS.map(d => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g'),
    label: 'Private project directory name',
  }] : []),
  {
    id: 'agent-handoff-id',
    severity: 'medium',
    // Match real handoff IDs, not JS module names like agent-handoff-ledger.
    // Real handoff IDs end in a date stamp (yyyy-mm-dd).
    re: /\b(?:agent-handoff|handoff)-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\b/gi,
    label: 'Agent handoff identifier (potential raw-memory ref)',
  },
  {
    id: 'recall-entry-id',
    severity: 'medium',
    // Match real KB entry IDs (which have a long digit timestamp or
    // hex hash suffix), not generic hyphenated identifiers like
    // feature-registry or feature-blueprint.
    re: /\b(?:decision|lesson|feature|milestone|entry|basin|specialist-(?:run|replay|proposal))-[a-z0-9-]*?(?:\d{10,}|[0-9a-f]{16,})\b/g,
    label: 'Recall KB entry identifier (potential private reference)',
  },
  {
    id: 'long-base64-blob',
    severity: 'medium',
    re: /[A-Za-z0-9+/]{200,}={0,2}/g,
    label: 'Long base64-shaped blob (possible encoded payload)',
  },
  {
    id: 'rfc1918-private-ip',
    severity: 'low',
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
    label: 'RFC1918 private IP address',
  },
  {
    id: 'jwt-token',
    severity: 'high',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    label: 'JWT (likely auth token)',
  },
];

function findMatches(content) {
  const findings = [];
  for (const detector of DETECTORS) {
    detector.re.lastIndex = 0;
    let m;
    while ((m = detector.re.exec(content)) !== null) {
      const sample = m[0].length > 40 ? m[0].slice(0, 16) + '…[+' + (m[0].length - 16) + ']' : m[0];
      findings.push({
        detectorId: detector.id,
        severity: detector.severity,
        label: detector.label,
        offset: m.index,
        length: m[0].length,
        sample,
      });
    }
  }
  return findings;
}

function classifyDecision(findings) {
  const hasHigh = findings.some((f) => f.severity === 'high');
  const hasMedium = findings.some((f) => f.severity === 'medium');
  if (hasHigh) return 'block';
  if (hasMedium) return 'review';
  return 'allow';
}

function contentHash(content) {
  return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
}

function scanContent({ content, kind = 'unknown', target = null, sourcePath = null } = {}) {
  if (typeof content !== 'string') {
    throw new Error('scanContent: content must be a string');
  }
  const findings = findMatches(content);
  const blockers = findings.filter((f) => f.severity === 'high').map((f) => ({
    detectorId: f.detectorId,
    severity: f.severity,
    issue: f.label,
    offset: f.offset,
    length: f.length,
    sample: f.sample,
  }));
  const warnings = findings.filter((f) => f.severity !== 'high').map((f) => ({
    detectorId: f.detectorId,
    severity: f.severity,
    concern: f.label,
    offset: f.offset,
    length: f.length,
    sample: f.sample,
  }));
  const decision = classifyDecision(findings);
  const hash = contentHash(content);
  const scanId = 'egress-scan-' + crypto.createHash('sha256')
    .update(hash + '|' + kind + '|' + (target || '') + '|' + (sourcePath || '') + '|' + Date.now())
    .digest('hex').slice(0, 16);
  return {
    scanId,
    decision,
    contentHash: hash,
    contentBytes: Buffer.byteLength(content, 'utf8'),
    kind,
    target,
    sourcePath,
    blockers,
    warnings,
    detectorVersion: 1,
    scannedAt: new Date().toISOString(),
  };
}

function scanFile(filePath, opts = {}) {
  const fs = require('fs');
  const content = fs.readFileSync(filePath, 'utf8');
  return scanContent({
    content,
    kind: opts.kind || 'file',
    target: opts.target || null,
    sourcePath: filePath,
  });
}

function scanDir(dirPath, opts = {}) {
  const fs = require('fs');
  const path = require('path');
  const exts = opts.extensions || ['.js', '.json', '.md', '.txt', '.html', '.css', '.yml', '.yaml', '.toml'];
  // Test directories legitimately contain synthetic detector bait; skip
  // them by default. Operator can override with opts.includeTests.
  const skipDirNames = new Set(['.git', 'node_modules']);
  if (!opts.includeTests) {
    for (const t of ['test', 'tests', '__tests__', 'spec', '__mocks__']) skipDirNames.add(t);
  }
  // Path fragments that mark internal-only artefacts even outside the
  // skip-dir set (e.g. agent handoff JSON dumps, IL artefact stores).
  const skipPathFragments = opts.includeInternalArtefacts ? [] : [
    path.sep + 'docs' + path.sep + 'agent-handoffs' + path.sep,
    path.sep + 'docs' + path.sep + 'examples' + path.sep + 'intelligence' + path.sep,
  ];
  const results = [];
  const stack = [dirPath];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (skipDirNames.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!exts.some((ext) => entry.name.endsWith(ext))) continue;
      if (skipPathFragments.some((frag) => full.includes(frag))) continue;
      try {
        const result = scanFile(full, { kind: opts.kind || 'mirror-file', target: opts.target || null });
        if (result.decision !== 'allow') results.push(result);
        else if (opts.includeAllowed) results.push(result);
      } catch (err) {
        results.push({
          scanId: null,
          decision: 'error',
          sourcePath: full,
          error: err.message,
        });
      }
    }
  }
  const summary = {
    scannedFiles: results.length,
    blockCount: results.filter((r) => r.decision === 'block').length,
    reviewCount: results.filter((r) => r.decision === 'review').length,
    errorCount: results.filter((r) => r.decision === 'error').length,
  };
  summary.aggregateDecision = summary.blockCount > 0 ? 'block' : (summary.reviewCount > 0 ? 'review' : 'allow');
  return { summary, results };
}

module.exports = {
  scanContent,
  scanFile,
  scanDir,
  DETECTORS,
};
