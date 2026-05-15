'use strict';

// open-source-readiness: allow-private-path-fixtures

const {
  DECISIONS,
  sanitizeMarkup,
  validateModelOutput,
} = require('../lib/output-validation');

describe('GEO-SEC-031 output validation gate', () => {
  test('allows only schema-approved tool arguments', () => {
    const allowed = validateModelOutput('tool_args', {
      docId: 'doc-1',
      reason: 'review',
    }, {
      allowedKeys: ['docId', 'reason'],
      requiredKeys: ['docId'],
    });
    const denied = validateModelOutput('tool_args', {
      docId: 'doc-1',
      rawSql: 'select * from secrets',
    }, {
      allowedKeys: ['docId', 'reason'],
      requiredKeys: ['docId'],
    });

    expect(allowed.decision).toBe(DECISIONS.ALLOW);
    expect(denied.decision).toBe(DECISIONS.DENY);
    expect(denied.reasons).toContain('unknown_key:rawSql');
  });

  test('denies raw SQL and allows only named templates', () => {
    const deniedRaw = validateModelOutput('sql', {
      rawSql: 'select * from private_records',
    }, {
      allowedTemplates: {
        search_public_notes: 'select * from notes where body like ?',
      },
    });
    const deniedUnknown = validateModelOutput('sql', {
      templateId: 'dump_private_tables',
      params: {},
    }, {
      allowedTemplates: {
        search_public_notes: 'select * from notes where body like ?',
      },
    });
    const allowed = validateModelOutput('sql', {
      templateId: 'search_public_notes',
      params: { q: 'geomorphic' },
    }, {
      allowedTemplates: {
        search_public_notes: 'select * from notes where body like ?',
      },
    });

    expect(deniedRaw.decision).toBe(DECISIONS.DENY);
    expect(deniedRaw.reasons).toContain('sql_template_not_allowed');
    expect(deniedUnknown.decision).toBe(DECISIONS.DENY);
    expect(allowed).toMatchObject({
      decision: DECISIONS.ALLOW,
      value: {
        templateId: 'search_public_notes',
        params: { q: 'geomorphic' },
      },
    });
  });

  test('enforces URL protocol and host allowlists', () => {
    expect(validateModelOutput('url', 'javascript:alert(1)', {
      allowedHosts: ['example.com'],
    }).reasons).toContain('url_protocol_not_allowed');
    expect(validateModelOutput('url', 'https://evil.test/path', {
      allowedHosts: ['example.com'],
    }).reasons).toContain('url_host_not_allowed');
    expect(validateModelOutput('url', 'https://example.com/path', {
      allowedHosts: ['example.com'],
    })).toMatchObject({
      decision: DECISIONS.ALLOW,
      value: 'https://example.com/path',
    });
  });

  test('blocks file path traversal outside the approved root', () => {
    const root = 'C:\\Users\\jesse\\Desktop\\recall-cli\\data\\exports';
    const denied = validateModelOutput('file_path', '..\\..\\secret.txt', { root });
    const allowed = validateModelOutput('file_path', 'report.md', { root });

    expect(denied.decision).toBe(DECISIONS.DENY);
    expect(denied.reasons).toContain('file_path_outside_root');
    expect(allowed.decision).toBe(DECISIONS.ALLOW);
    expect(allowed.value.toLowerCase()).toContain('\\data\\exports\\report.md');
  });

  test('denies shell execution by default and rejects control operators in args', () => {
    expect(validateModelOutput('shell', {
      command: 'node',
      args: ['script.js'],
    }).reasons).toContain('shell_execution_denied_by_default');

    const deniedArg = validateModelOutput('shell', {
      command: 'node',
      args: ['script.js', 'ok; rm -rf .'],
    }, {
      allowShell: true,
      allowedCommands: ['node'],
    });
    const allowed = validateModelOutput('shell', {
      command: 'node',
      args: ['script.js', 'safe-arg'],
    }, {
      allowShell: true,
      allowedCommands: ['node'],
    });

    expect(deniedArg.decision).toBe(DECISIONS.DENY);
    expect(deniedArg.reasons).toContain('shell_arg_contains_control_operator');
    expect(allowed.decision).toBe(DECISIONS.ALLOW);
  });

  test('sanitizes HTML and Markdown before rendering sinks', () => {
    const input = '<p onclick="steal()">Hi</p><script>alert(1)</script>[x](javascript:alert(1))';
    const result = validateModelOutput('html', input);

    expect(result.decision).toBe(DECISIONS.REDACT);
    expect(result.reasons).toEqual(['markup_sanitized']);
    expect(result.value).not.toContain('<script>');
    expect(result.value).not.toContain('onclick');
    expect(result.value).not.toContain('javascript:');
    expect(sanitizeMarkup(input)).toBe(result.value);
  });

  test('emits audit events without raw sink payloads', () => {
    const result = validateModelOutput('url', 'https://evil.test/secret', {
      allowedHosts: ['example.com'],
    });

    expect(result.auditEvent).toMatchObject({
      eventType: 'output_validation_check',
      sink: 'url',
      policyDecision: 'deny',
      policyReasons: ['url_host_not_allowed'],
    });
    expect(JSON.stringify(result.auditEvent)).not.toContain('secret');
  });
});
