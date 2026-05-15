'use strict';

/**
 * nl-interpreter.js — Maps natural language to Meridian CLI commands.
 * No external API needed — uses keyword matching + intent classification.
 */

const INTENTS = [
  {
    command: 'search',
    keywords: ['search', 'find', 'look', 'show me', 'what', 'where', 'which', 'list'],
    pattern: /(?:search\s+for|search|find|look\s+for|show\s+me|which)\s+(.+)/i,
    build: (match, project) => ({ cmd: 'search', args: [project, match[1].trim()].filter(Boolean) })
  },
  {
    command: 'ingest',
    keywords: ['ingest', 'import', 'fetch', 'paper', 'doi', 'pubmed', 'arxiv', 'add paper', 'read paper'],
    pattern: /(?:ingest|import|fetch|add\s+paper|read\s+paper)\s+(.+)/i,
    build: (match, project) => ({ cmd: 'ingest', args: [match[1].trim()], flags: project ? { project } : {} })
  },
  {
    command: 'add',
    keywords: ['add', 'create', 'new entry', 'log', 'record'],
    pattern: /(?:add|create|new|log|record)\s+(?:entry|finding|result|experiment)?\s*(.*)/i,
    build: (match, project) => ({ cmd: 'add', args: [project].filter(Boolean) })
  },
  {
    command: 'browse',
    keywords: ['browse', 'list entries', 'show entries', 'all entries', 'view'],
    pattern: /(?:browse|list|show|view)\s+(?:all\s+)?(?:entries|findings|results)?\s*(.*)/i,
    build: (match, project) => ({ cmd: 'browse', args: [project].filter(Boolean) })
  },
  {
    command: 'status',
    keywords: ['status', 'stats', 'overview', 'how many', 'count', 'summary'],
    pattern: /(?:status|stats|overview|summary|how\s+many|count)/i,
    build: () => ({ cmd: 'status', args: [] })
  },
  {
    command: 'verify',
    keywords: ['verify', 'confirm', 'check', 'refresh', 'update verification'],
    pattern: /(?:verify|confirm|refresh|re-?verify)\s+(.+)/i,
    build: (match, project) => ({ cmd: 'verify', args: [project, match[1].trim()].filter(Boolean) })
  },
  {
    command: 'query',
    keywords: ['query', 'table', 'select', 'sql'],
    pattern: /(?:query|TABLE)\s+(.+)/i,
    build: (match, project) => ({ cmd: 'query', args: [project, match[1].trim()].filter(Boolean) })
  },
  {
    command: 'push',
    keywords: ['push', 'share', 'upload', 'publish', 'send to server'],
    pattern: /(?:push|share|upload|publish|send)\s*(.*)/i,
    build: (match, project) => ({ cmd: 'push', args: [project, match[1].trim()].filter(Boolean) })
  },
  {
    command: 'pull',
    keywords: ['pull', 'download', 'get from server', 'sync'],
    pattern: /(?:pull|download|get\s+from\s+server|sync)\s*(.*)/i,
    build: (match, project) => ({ cmd: 'pull', args: [match[1].trim()].filter(Boolean) })
  },
  {
    command: 'export',
    keywords: ['export', 'markdown', 'obsidian', 'save as'],
    pattern: /(?:export|save\s+as|to\s+markdown|to\s+obsidian)\s*(.*)/i,
    build: (match, project) => ({ cmd: 'export', args: [project || match[1].trim()].filter(Boolean) })
  },
  {
    command: 'config',
    keywords: ['config', 'settings', 'configure', 'set server', 'set api'],
    pattern: /(?:config|settings|configure|set)\s*(.*)/i,
    build: (match) => ({ cmd: 'config', args: match[1] ? ['set', ...match[1].split(/\s+/)] : ['get'] })
  },
  {
    command: 'init',
    keywords: ['init', 'initialize', 'create project', 'new project', 'start'],
    pattern: /(?:init|initialize|create\s+project|new\s+project|start)\s*(.*)/i,
    build: () => ({ cmd: 'init', args: [] })
  }
];

/**
 * Interpret natural language input into a CLI command.
 * @param {string} input — natural language text
 * @param {string} [defaultProject] — default project to use if not specified
 * @returns {{ cmd: string, args: string[], flags: object, confidence: number, interpretation: string } | null}
 */
function interpret(input, defaultProject = '') {
  if (!input || !input.trim()) return null;
  const text = input.trim();

  // Score each intent by keyword matches
  let bestIntent = null;
  let bestScore = 0;

  for (const intent of INTENTS) {
    let score = 0;
    const lower = text.toLowerCase();

    // Keyword matching
    for (const kw of intent.keywords) {
      if (lower.includes(kw)) score += kw.split(' ').length; // multi-word keywords score higher
    }

    // Pattern matching bonus
    const match = text.match(intent.pattern);
    if (match) score += 3;

    if (score > bestScore) {
      bestScore = score;
      bestIntent = { intent, match, score };
    }
  }

  if (!bestIntent || bestScore < 1) return null;

  const { intent, match } = bestIntent;
  const result = intent.build(match || [text, text], defaultProject);

  // Build human-readable interpretation
  const argsStr = result.args.filter(Boolean).join(' ');
  const interpretation = `meridian ${result.cmd}${argsStr ? ' ' + argsStr : ''}`;

  return {
    cmd: result.cmd,
    args: result.args || [],
    flags: result.flags || {},
    confidence: Math.min(bestScore / 6, 1), // normalize to 0-1
    interpretation
  };
}

module.exports = { interpret, INTENTS };
