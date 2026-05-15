'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'docs', 'plans', 'research-extractions');

function read(name) {
  return fs.readFileSync(path.join(ROOT, name), 'utf8');
}

function compact(text) {
  return text.replace(/\s+/g, ' ');
}

describe('geomorphic research extraction guardrails', () => {
  test('keeps the five named primary-source extractions present', () => {
    const names = fs.readdirSync(ROOT).sort();

    expect(names).toEqual(expect.arrayContaining([
      '2026-05-03-camel-capability-security-extraction.md',
      '2026-05-03-microsoft-spotlighting-extraction.md',
      '2026-05-03-nist-ai-rmf-genai-profile-extraction.md',
      '2026-05-03-owasp-llm-top-10-2025-extraction.md',
      '2026-05-03-owasp-mcp-top-10-extraction.md',
    ]));
  });

  test('pins Spotlighting as retrieval-time channel lining, not a partition replacement', () => {
    const text = read('2026-05-03-microsoft-spotlighting-extraction.md');
    const normalized = compact(text);

    expect(text).toContain('delimiting');
    expect(text).toContain('datamarking');
    expect(text).toContain('encoding');
    expect(text).toContain('retrieval-time guard');
    expect(normalized).toContain('not a replacement for provenance, quarantine, vector filtering, or tool policy');
  });

  test('pins CaMeL as the feature/tool capability spine', () => {
    const text = read('2026-05-03-camel-capability-security-extraction.md');

    expect(text).toContain('the model must not be the authority that decides what actions are safe');
    expect(text).toContain('control flow and data flow');
    expect(text).toContain('untrusted data retrieved later cannot change the program flow');
    expect(text).toContain('FeatureCapability');
    expect(text).toContain('ToolGateway');
  });

  test('pins OWASP LLM controls to vector isolation, output handling, and agency limits', () => {
    const text = read('2026-05-03-owasp-llm-top-10-2025-extraction.md');

    expect(text).toContain('LLM01: Prompt Injection');
    expect(text).toContain('LLM05: Improper Output Handling');
    expect(text).toContain('LLM06: Excessive Agency');
    expect(text).toContain('LLM08: Vector and Embedding Weaknesses');
    expect(text).toContain('strict vector access partitioning');
    expect(text).toContain('immutable retrieval and security logs');
  });

  test('pins OWASP MCP as beta guidance for capability-bearing features', () => {
    const text = read('2026-05-03-owasp-mcp-top-10-extraction.md');

    expect(text).toContain('beta/pilot release');
    expect(text).toContain('Features are not just prompts');
    expect(text).toContain('capability-bearing software');
    expect(text).toContain('credentials');
    expect(text).toContain('audit duties');
  });

  test('pins NIST GenAI profile to lifecycle, provenance, and audit duties', () => {
    const text = read('2026-05-03-nist-ai-rmf-genai-profile-extraction.md');

    expect(text).toContain('govern');
    expect(text).toContain('map');
    expect(text).toContain('measure');
    expect(text).toContain('manage');
    expect(text).toContain('content provenance');
    expect(text).toContain('incident disclosure');
  });
});
