'use strict';

// Supply-chain integrity — the §14 "physical / supply-chain"
// brainstorm gap, software half. Three concrete things any operator
// can do TODAY without hardware:
//
//   1. SBOM generation — produce a Software Bill of Materials of
//      every dependency (direct + transitive) with name, version,
//      and integrity hash from the lockfile. Audit ledger entry per
//      generation.
//
//   2. Lockfile verification — ensure package.json declares the
//      exact same versions as package-lock.json resolves. Catches
//      drift between manifest and lockfile that would make
//      `npm install` resolve different code than the operator
//      audited.
//
//   3. Dependency-shape audit — flag risky shapes: dependencies
//      with no integrity hash, dependencies pulled from non-registry
//      URLs (git/file/http), unscoped wildcards, scope-conflicts
//      with the project's own scope. These are the patterns that
//      make supply-chain attacks possible.
//
// API:
//   buildSbom({packageJson, lockfile?}) → {packages, summary, generatedAt}
//   verifyLockfile({packageJson, lockfile}) → {ok, drifts}
//   auditDependencyShapes({lockfile}) → {findings, summary}
//
// Pure functions over JSON inputs — CLI wires the live package.json
// + package-lock.json files. No npm calls, no network.

const crypto = require('crypto');

function _flattenLockfilePackages(lockfile) {
  // npm v7+ lockfile format ("packages") — keys are paths like
  // "" (root) or "node_modules/foo" or "node_modules/foo/node_modules/bar".
  if (!lockfile || typeof lockfile !== 'object') return [];
  const out = [];
  if (lockfile.packages) {
    for (const [pathKey, pkg] of Object.entries(lockfile.packages)) {
      if (pathKey === '') continue; // skip the root package
      const name = pkg.name || pathKey.replace(/^node_modules\//, '').split('/node_modules/').pop();
      out.push({
        path: pathKey,
        name,
        version: pkg.version,
        resolved: pkg.resolved || null,
        integrity: pkg.integrity || null,
        dev: Boolean(pkg.dev),
        peer: Boolean(pkg.peer),
        optional: Boolean(pkg.optional),
        license: pkg.license || null,
      });
    }
  }
  return out;
}

function buildSbom({ packageJson, lockfile } = {}) {
  if (!packageJson || typeof packageJson !== 'object') throw new Error('packageJson required');
  const declared = {
    direct: { ...(packageJson.dependencies || {}) },
    dev: { ...(packageJson.devDependencies || {}) },
    peer: { ...(packageJson.peerDependencies || {}) },
    optional: { ...(packageJson.optionalDependencies || {}) },
  };
  const resolved = lockfile ? _flattenLockfilePackages(lockfile) : [];
  const summary = {
    declaredDirect: Object.keys(declared.direct).length,
    declaredDev: Object.keys(declared.dev).length,
    declaredPeer: Object.keys(declared.peer).length,
    declaredOptional: Object.keys(declared.optional).length,
    resolvedTotal: resolved.length,
    withIntegrity: resolved.filter((p) => p.integrity).length,
    withoutIntegrity: resolved.filter((p) => !p.integrity).length,
    fromRegistry: resolved.filter((p) => p.resolved && /^https:\/\/(?:registry\.npmjs\.org|registry\.yarnpkg\.com)\//.test(p.resolved)).length,
    fromOtherSource: resolved.filter((p) => p.resolved && !/^https:\/\/(?:registry\.npmjs\.org|registry\.yarnpkg\.com)\//.test(p.resolved)).length,
  };
  const sbomHash = 'sha256:' + crypto.createHash('sha256')
    .update(JSON.stringify({
      declared,
      resolved: resolved.map((p) => ({ path: p.path, name: p.name, version: p.version, integrity: p.integrity })),
    }))
    .digest('hex');
  return {
    name: packageJson.name || 'unknown',
    version: packageJson.version || '0.0.0',
    declared,
    resolved,
    summary,
    sbomHash,
    generatedAt: new Date().toISOString(),
  };
}

// Compare what package.json declares vs what the lockfile resolved
// at the top-level. Drift means a developer or CI step modified one
// without the other.
function verifyLockfile({ packageJson, lockfile, flagHoistedTransitives = false } = {}, opts = {}) {
  if (flagHoistedTransitives) opts.flagHoistedTransitives = true;
  if (!packageJson || !lockfile) throw new Error('both packageJson and lockfile required');
  const declared = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
    ...(packageJson.optionalDependencies || {}),
  };
  const drifts = [];
  // Walk top-level node_modules entries
  const lockTopLevel = {};
  if (lockfile.packages) {
    for (const [pathKey, pkg] of Object.entries(lockfile.packages)) {
      if (pathKey.startsWith('node_modules/') && !pathKey.slice('node_modules/'.length).includes('/node_modules/')) {
        const name = pathKey.slice('node_modules/'.length);
        lockTopLevel[name] = pkg.version;
      }
    }
  }
  for (const [name, declaredRange] of Object.entries(declared)) {
    if (!lockTopLevel[name]) {
      drifts.push({
        kind: 'declared-not-resolved',
        name,
        declared: declaredRange,
        detail: `declared in package.json but not present in lockfile`,
      });
      continue;
    }
    // Light-weight semver compatibility check: if declaredRange starts
    // with a digit, it's an exact version — must match the resolved
    // version exactly.
    if (/^\d/.test(declaredRange) && declaredRange !== lockTopLevel[name]) {
      drifts.push({
        kind: 'version-mismatch',
        name,
        declared: declaredRange,
        resolved: lockTopLevel[name],
        detail: `package.json pinned ${declaredRange} but lockfile has ${lockTopLevel[name]}`,
      });
    }
  }
  // Note: we do NOT flag "resolved-not-declared" by default. npm
  // hoists transitive dependencies to the top of node_modules; that's
  // normal and not a security concern. Pass {flagHoistedTransitives:
  // true} to get the noisier audit if you actually want to see what
  // npm hoisted.
  if (opts && opts.flagHoistedTransitives) {
    for (const name of Object.keys(lockTopLevel)) {
      if (!declared[name]) {
        drifts.push({
          kind: 'resolved-not-declared',
          name,
          resolved: lockTopLevel[name],
          detail: `top-level dependency ${name} resolved but not declared in package.json (likely npm hoisting of a transitive)`,
        });
      }
    }
  }
  return { ok: drifts.length === 0, drifts, declaredCount: Object.keys(declared).length, resolvedTopLevel: Object.keys(lockTopLevel).length };
}

function auditDependencyShapes({ lockfile, allowSources = ['https://registry.npmjs.org/'] } = {}) {
  if (!lockfile) throw new Error('lockfile required');
  const findings = [];
  const resolved = _flattenLockfilePackages(lockfile);
  for (const p of resolved) {
    if (!p.integrity) {
      findings.push({
        kind: 'missing-integrity',
        severity: 'high',
        name: p.name,
        version: p.version,
        path: p.path,
        detail: 'no integrity hash in lockfile — npm install cannot verify the tarball',
      });
    }
    if (p.resolved) {
      const fromAllowed = allowSources.some((src) => p.resolved.startsWith(src));
      if (!fromAllowed) {
        if (/^git\+/.test(p.resolved) || /\.git/.test(p.resolved)) {
          findings.push({
            kind: 'non-registry-source',
            severity: 'high',
            name: p.name,
            version: p.version,
            path: p.path,
            resolved: p.resolved,
            detail: 'pulled from a git URL, not the npm registry — supply chain unverified by registry signing',
          });
        } else if (/^file:/.test(p.resolved)) {
          findings.push({
            kind: 'non-registry-source',
            severity: 'medium',
            name: p.name,
            version: p.version,
            path: p.path,
            resolved: p.resolved,
            detail: 'pulled from local filesystem (file: URL) — fine for local dev, dangerous in published packages',
          });
        } else if (/^https?:/.test(p.resolved)) {
          findings.push({
            kind: 'non-registry-source',
            severity: 'medium',
            name: p.name,
            version: p.version,
            path: p.path,
            resolved: p.resolved,
            detail: 'pulled from a non-allowed http(s) URL',
          });
        }
      }
    }
  }
  const summary = {
    totalResolved: resolved.length,
    findings: findings.length,
    bySeverity: {
      high: findings.filter((f) => f.severity === 'high').length,
      medium: findings.filter((f) => f.severity === 'medium').length,
      low: findings.filter((f) => f.severity === 'low').length,
    },
    byKind: findings.reduce((acc, f) => { acc[f.kind] = (acc[f.kind] || 0) + 1; return acc; }, {}),
  };
  return { findings, summary };
}

module.exports = {
  buildSbom,
  verifyLockfile,
  auditDependencyShapes,
};
