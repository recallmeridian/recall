'use strict';

const path = require('path');

const DECISIONS = {
  ALLOW: 'allow',
  DENY: 'deny',
  REDACT: 'redact',
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function deny(sink, reasons, details = {}) {
  return {
    decision: DECISIONS.DENY,
    sink,
    reasons,
    value: null,
    auditEvent: auditEvent(sink, DECISIONS.DENY, reasons, details),
  };
}

function allow(sink, value, reasons = ['output_validation_allowed'], details = {}) {
  return {
    decision: DECISIONS.ALLOW,
    sink,
    reasons,
    value,
    auditEvent: auditEvent(sink, DECISIONS.ALLOW, reasons, details),
  };
}

function redactDecision(sink, value, reasons, details = {}) {
  return {
    decision: DECISIONS.REDACT,
    sink,
    reasons,
    value,
    auditEvent: auditEvent(sink, DECISIONS.REDACT, reasons, details),
  };
}

function auditEvent(sink, decision, reasons, details = {}) {
  return {
    eventType: 'output_validation_check',
    sink,
    policyDecision: decision,
    policyReasons: reasons,
    details,
  };
}

function validateToolArgs(value, schema = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return deny('tool_args', ['tool_args_must_be_object']);
  }
  const allowedKeys = asArray(schema.allowedKeys);
  const requiredKeys = asArray(schema.requiredKeys);
  const unknownKeys = Object.keys(value).filter((key) => allowedKeys.length > 0 && !allowedKeys.includes(key));
  const missingKeys = requiredKeys.filter((key) => value[key] === undefined);

  if (unknownKeys.length > 0 || missingKeys.length > 0) {
    return deny('tool_args', [
      ...unknownKeys.map((key) => `unknown_key:${key}`),
      ...missingKeys.map((key) => `missing_key:${key}`),
    ], {
      unknownKeys,
      missingKeys,
    });
  }

  return allow('tool_args', { ...value }, ['tool_args_schema_allowed'], {
    keys: Object.keys(value),
  });
}

function validateSql(value, options = {}) {
  const templateId = value && typeof value === 'object' ? value.templateId : '';
  const params = value && typeof value === 'object' && value.params && typeof value.params === 'object'
    ? value.params
    : {};
  const allowedTemplates = options.allowedTemplates || {};

  if (!templateId || !allowedTemplates[templateId]) {
    return deny('sql', ['sql_template_not_allowed'], { templateId });
  }
  if (typeof value === 'string' || (value && value.rawSql)) {
    return deny('sql', ['raw_sql_denied'], { templateId });
  }

  return allow('sql', {
    templateId,
    params: { ...params },
  }, ['sql_template_allowed'], { templateId });
}

function validateUrl(value, options = {}) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch (_) {
    return deny('url', ['invalid_url']);
  }

  const allowedHosts = asArray(options.allowedHosts);
  const allowedProtocols = asArray(options.allowedProtocols).length
    ? asArray(options.allowedProtocols)
    : ['https:'];

  if (!allowedProtocols.includes(parsed.protocol)) {
    return deny('url', ['url_protocol_not_allowed'], { protocol: parsed.protocol });
  }
  if (allowedHosts.length > 0 && !allowedHosts.includes(parsed.hostname)) {
    return deny('url', ['url_host_not_allowed'], { hostname: parsed.hostname });
  }

  return allow('url', parsed.toString(), ['url_allowed'], {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
  });
}

function normalizePathWithin(root, candidate) {
  const resolvedRoot = path.resolve(String(root || ''));
  const resolvedCandidate = path.resolve(resolvedRoot, String(candidate || ''));
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  return {
    resolvedRoot,
    resolvedCandidate,
    inside,
  };
}

function validateFilePath(value, options = {}) {
  if (!options.root) return deny('file_path', ['file_path_root_required']);
  const normalized = normalizePathWithin(options.root, value);
  if (!normalized.inside) {
    return deny('file_path', ['file_path_outside_root'], {
      root: normalized.resolvedRoot,
    });
  }
  return allow('file_path', normalized.resolvedCandidate, ['file_path_allowed'], {
    root: normalized.resolvedRoot,
  });
}

function validateShell(value, options = {}) {
  if (options.allowShell !== true) {
    return deny('shell', ['shell_execution_denied_by_default']);
  }
  const allowedCommands = asArray(options.allowedCommands);
  const command = value && typeof value === 'object' ? value.command : '';
  const args = asArray(value && value.args);
  if (!command || !allowedCommands.includes(command)) {
    return deny('shell', ['shell_command_not_allowed'], { command });
  }
  if (args.some((arg) => /[;&|`<>$]/.test(String(arg)))) {
    return deny('shell', ['shell_arg_contains_control_operator'], { command });
  }
  return allow('shell', { command, args }, ['shell_command_allowed'], { command });
}

function sanitizeMarkup(value) {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/javascript:/gi, 'blocked:');
}

function validateMarkup(value) {
  const sanitized = sanitizeMarkup(value);
  if (sanitized !== String(value)) {
    return redactDecision('markup', sanitized, ['markup_sanitized']);
  }
  return allow('markup', sanitized, ['markup_allowed']);
}

function validateModelOutput(sink, value, options = {}) {
  switch (sink) {
    case 'tool_args':
      return validateToolArgs(value, options.schema || options);
    case 'sql':
      return validateSql(value, options);
    case 'url':
      return validateUrl(value, options);
    case 'file_path':
      return validateFilePath(value, options);
    case 'shell':
      return validateShell(value, options);
    case 'html':
    case 'markdown':
    case 'markup':
      return validateMarkup(value);
    default:
      return deny(sink || 'unknown', ['unknown_output_sink']);
  }
}

module.exports = {
  DECISIONS,
  sanitizeMarkup,
  validateFilePath,
  validateModelOutput,
  validateShell,
  validateSql,
  validateToolArgs,
  validateUrl,
};
