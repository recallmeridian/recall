'use strict';

// Multi-agent collusion detector — closes the §14 open gap from the
// 2026-05-12 brainstorm: "when scaling beyond one OpenClaw, joint
// behavior can violate intent while individual actions pass capability
// gates."
//
// Operates on action records (the same shape produced by
// audit-ingest). Looks for FOUR patterns of joint behavior that no
// single per-agent gate can catch:
//
//   1. SPLIT-LEAK
//      Two or more agents each emit a partial fragment of the same
//      private content (e.g. agent A posts the prefix of an absolute
//      path, agent B posts the suffix). Detected by reassembling
//      adjacent fragments and rescanning with the egress detector.
//
//   2. RATE-AGGREGATION
//      Each agent stays under its individual rate limit, but the
//      sum across N agents exceeds intent. Detected by a sliding-
//      window action-frequency aggregation across all agentIds.
//
//   3. INFORMATION-AGGREGATION
//      Many agents each retrieve a different slice of the same
//      private decision; individually each retrieval is read-only,
//      collectively they reconstruct the protected entry. Detected
//      by counting distinct retrievers per evidence id within a
//      window.
//
//   4. COORDINATED-EGRESS-TIMING
//      Agents post on a regular interval (e.g. every 30s, every
//      hour on the second) — a fingerprint of automated coordination
//      rather than independent organic activity. Detected by
//      inter-arrival-time variance.
//
// API:
//   detectCollusion({records, scanContent?, windowHours?, ...})
//     → {
//         findings: [{kind, agentIds, evidence, severity, detail}],
//         summary: {byKind, totalAgents, windowHours},
//       }
//
// Pure function — pass action records and (optionally) the
// scanContent function for split-leak reassembly. CLI wires real
// records from audit-ingest + the egress scanner.

function _hours(ms) { return ms / (1000 * 60 * 60); }

function _byTime(records) {
  return [...records].sort((a, b) => Date.parse(a.timestamp || 0) - Date.parse(b.timestamp || 0));
}

function _agentSet(records) {
  return new Set(records.map((r) => r.agentId).filter(Boolean));
}

function _detectSplitLeak(records, scanContent) {
  if (typeof scanContent !== 'function') return [];
  // Only consider 'post' / 'http_request' / 'tool_call' actions with
  // a target that has a `text` field to reassemble.
  const eligible = records.filter((r) => r.target && typeof r.target.text === 'string');
  if (eligible.length < 2) return [];
  // Group by adjacency in time within a 5-minute window.
  const byTime = _byTime(eligible);
  const findings = [];
  for (let i = 0; i < byTime.length; i++) {
    const a = byTime[i];
    const aTime = Date.parse(a.timestamp);
    for (let j = i + 1; j < byTime.length; j++) {
      const b = byTime[j];
      const bTime = Date.parse(b.timestamp);
      if (!Number.isFinite(bTime) || (bTime - aTime) > 5 * 60 * 1000) break;
      if (a.agentId === b.agentId) continue;
      // Try the two possible orderings.
      for (const concat of [a.target.text + b.target.text, b.target.text + a.target.text]) {
        const aloneA = scanContent({ content: a.target.text });
        const aloneB = scanContent({ content: b.target.text });
        const joined = scanContent({ content: concat });
        // Split-leak signature: BOTH parts pass alone (allow), but
        // joined triggers a high-severity blocker.
        if (aloneA.decision !== 'block' && aloneB.decision !== 'block' && joined.decision === 'block') {
          findings.push({
            kind: 'split-leak',
            agentIds: [a.agentId, b.agentId],
            evidence: [a.recordId || a.id, b.recordId || b.id].filter(Boolean),
            severity: 'high',
            detail: 'joined content from two agents triggers ' + joined.blockers.length + ' blocker(s); each part alone passed',
          });
          break;
        }
      }
    }
  }
  return findings;
}

function _detectRateAggregation(records, opts) {
  const ratePerHourCap = opts.ratePerHourCap || 30; // default cap on aggregate posts/hour
  const minSamples = opts.rateMinSamples || 4;
  const window = _byTime(records);
  if (window.length < minSamples) return []; // need enough samples for a meaningful rate
  const firstMs = Date.parse(window[0].timestamp);
  const lastMs = Date.parse(window[window.length - 1].timestamp);
  // Floor span at 6 minutes (0.1h) to avoid divide-by-tiny when many
  // records arrive nearly simultaneously (which is itself suspicious
  // but is captured by coordinated-timing, not rate-aggregation).
  const spanHours = Math.max(0.1, _hours(lastMs - firstMs));
  const byActionKind = {};
  for (const r of window) {
    const kind = r.actionKind || 'unknown';
    if (!byActionKind[kind]) byActionKind[kind] = [];
    byActionKind[kind].push(r);
  }
  const findings = [];
  for (const [kind, items] of Object.entries(byActionKind)) {
    const ratePerHour = items.length / spanHours;
    if (ratePerHour > ratePerHourCap) {
      findings.push({
        kind: 'rate-aggregation',
        agentIds: [...new Set(items.map((r) => r.agentId))],
        evidence: items.slice(0, 10).map((r) => r.recordId || r.id).filter(Boolean),
        severity: ratePerHour > ratePerHourCap * 2 ? 'high' : 'medium',
        detail: `aggregate ${kind} rate ${ratePerHour.toFixed(1)}/hour across ${new Set(items.map((r) => r.agentId)).size} agent(s) exceeds cap ${ratePerHourCap}`,
      });
    }
  }
  return findings;
}

function _detectInformationAggregation(records, opts) {
  const distinctRetrieverCap = opts.distinctRetrieverCap || 3;
  const reads = records.filter((r) => r.actionKind === 'read_kb' || r.actionKind === 'retrieval' || r.actionKind === 'read');
  const byEvidence = {};
  for (const r of reads) {
    for (const eid of (r.evidence || [])) {
      if (!byEvidence[eid]) byEvidence[eid] = new Set();
      byEvidence[eid].add(r.agentId);
    }
  }
  const findings = [];
  for (const [eid, agents] of Object.entries(byEvidence)) {
    if (agents.size > distinctRetrieverCap) {
      findings.push({
        kind: 'information-aggregation',
        agentIds: [...agents],
        evidence: [eid],
        severity: agents.size > distinctRetrieverCap * 2 ? 'high' : 'medium',
        detail: `${agents.size} distinct agents retrieved evidence ${eid} (cap ${distinctRetrieverCap}) — possible reconstruction attack`,
      });
    }
  }
  return findings;
}

function _detectCoordinatedTiming(records, opts) {
  const minSamples = opts.timingMinSamples || 6;
  const cvCap = opts.timingCvCap || 0.10; // inter-arrival CV below this looks scripted
  const byActionKind = {};
  for (const r of records) {
    const kind = r.actionKind || 'unknown';
    if (!byActionKind[kind]) byActionKind[kind] = [];
    byActionKind[kind].push(r);
  }
  const findings = [];
  for (const [kind, items] of Object.entries(byActionKind)) {
    if (items.length < minSamples) continue;
    const sorted = _byTime(items);
    const intervals = [];
    for (let i = 1; i < sorted.length; i++) {
      const a = Date.parse(sorted[i - 1].timestamp);
      const b = Date.parse(sorted[i].timestamp);
      if (Number.isFinite(a) && Number.isFinite(b)) intervals.push(b - a);
    }
    if (intervals.length < minSamples - 1) continue;
    const mean = intervals.reduce((acc, v) => acc + v, 0) / intervals.length;
    if (mean === 0) continue;
    const variance = intervals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / intervals.length;
    const stddev = Math.sqrt(variance);
    const cv = stddev / mean;
    if (cv < cvCap) {
      findings.push({
        kind: 'coordinated-timing',
        agentIds: [...new Set(sorted.map((r) => r.agentId))],
        evidence: sorted.slice(0, 10).map((r) => r.recordId || r.id).filter(Boolean),
        severity: 'medium',
        detail: `${kind} inter-arrival CV ${cv.toFixed(3)} below ${cvCap} across ${sorted.length} actions — fingerprint of scripted/coordinated cadence`,
      });
    }
  }
  return findings;
}

function detectCollusion({ records, scanContent, windowHours = 24, ratePerHourCap = 30, distinctRetrieverCap = 3, timingMinSamples = 6, timingCvCap = 0.10 } = {}) {
  if (!Array.isArray(records)) throw new Error('records must be an array');
  // Optionally constrain to the window
  let windowed = records;
  if (windowHours && Number.isFinite(windowHours)) {
    const cutoff = Date.now() - windowHours * 60 * 60 * 1000;
    windowed = records.filter((r) => {
      const t = Date.parse(r.timestamp || 0);
      return Number.isFinite(t) && t >= cutoff;
    });
  }
  const opts = { ratePerHourCap, distinctRetrieverCap, timingMinSamples, timingCvCap };
  const findings = [
    ..._detectSplitLeak(windowed, scanContent),
    ..._detectRateAggregation(windowed, opts),
    ..._detectInformationAggregation(windowed, opts),
    ..._detectCoordinatedTiming(windowed, opts),
  ];

  const byKind = {};
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  const totalAgents = _agentSet(windowed).size;

  return {
    findings,
    summary: {
      byKind,
      totalAgents,
      totalRecords: windowed.length,
      windowHours,
    },
  };
}

module.exports = {
  detectCollusion,
};
