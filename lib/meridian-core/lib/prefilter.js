'use strict';

// Plan 1D Task 12 — Structured pre-filter resolver.
//
// Converts a caller-supplied filter object into a parameterized SQLite WHERE
// fragment for the retrieval route (Task 14).
//
// OWASP Top-10 A03:2021 Injection — prevention combines (a) parameterized
// value bindings (every `?` is resolved through better-sqlite3's prepared-
// statement binder, never string-interpolated) and (b) identifier
// whitelisting: key names drive a switch over string-literal cases so unknown
// keys cannot reach the SQL builder. The route layer (Task 14) validates the
// input shape too; dropping unknown keys silently here is defense-in-depth.
//
// json_extract / json_each are SQLite JSON1 extension functions, bundled with
// better-sqlite3 by default — no runtime load step required.
//
// Frozen so callers cannot mutate the whitelist at runtime and slip a new
// field name past the switch.
const ALLOWED_PREFILTER_FIELDS = Object.freeze([
  'sub_profile',
  'applicability.language',
  'credential_required',
  'evidence.type',
]);

/**
 * @param {Object} [filter] flat key→value object; keys MUST be in
 *   ALLOWED_PREFILTER_FIELDS. Unknown keys are silently dropped.
 * @returns {{where: string, params: any[]}} `where` is the AND-combined
 *   clause with no leading 'WHERE'. Empty/missing filter → {where: '',
 *   params: []} so the route can do `if (where) sql += ' WHERE ' + where`.
 */
function buildPrefilterSQL(filter) {
  if (!filter || typeof filter !== 'object') return { where: '', params: [] };

  const clauses = [];
  const params = [];

  for (const [key, value] of Object.entries(filter)) {
    if (!ALLOWED_PREFILTER_FIELDS.includes(key)) continue;
    switch (key) {
      case 'sub_profile':
        clauses.push('sub_profile = ?');
        params.push(value);
        break;
      case 'applicability.language':
        clauses.push("json_extract(applicability, '$.language') = ?");
        params.push(value);
        break;
      case 'credential_required':
        // SQLite has no native boolean — INTEGER 0/1 is the canonical encoding.
        clauses.push('credential_required = ?');
        params.push(value ? 1 : 0);
        break;
      case 'evidence.type':
        // Array-contains: does any element of the evidence JSON array have
        // .type === value? EXISTS short-circuits on first match.
        clauses.push(
          "EXISTS (SELECT 1 FROM json_each(evidence) WHERE json_extract(value, '$.type') = ?)"
        );
        params.push(value);
        break;
    }
  }

  return { where: clauses.join(' AND '), params };
}

module.exports = { buildPrefilterSQL, ALLOWED_PREFILTER_FIELDS };
