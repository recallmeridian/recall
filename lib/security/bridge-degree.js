'use strict';

// Bridge-degree caps — closes failure mode #7b ("mother-tree fallacy")
// from the 2026-05-12 OpenClaw security brainstorm.
//
// Background: feature-bridge-map produces cross-project bridge
// candidates from retrieval reconsolidation events. Without a cap on
// per-node degree, a single high-traffic entry can become a
// concentrated routing hub — failure cascades through it, single
// point of compromise, contradicts the diffuse-mesh design ethic
// the brainstorm calls for.
//
// API:
//   evaluateBridgeDegrees({relations, capPerNode, capPerProject?})
//     → {
//         decision: 'allow' | 'requires_pruning' | 'block',
//         exceedances: [{nodeId, degree, cap, edges:[...]}],
//         summary: { totalNodes, totalEdges, maxDegree, mean }
//       }
//
//   suggestPruning({exceedances, strategy: 'oldest-first' | 'lowest-confidence' | 'random'})
//     → [{nodeId, edgesToRetire:[...], retainedDegree}]
//
// Pure data — relations are passed in as
//   [{ from, to, project?, createdAt?, confidence?, kind? }, ...]
//
// The CLI command wires this to feature-bridge-map output.

function _degreeIndex(relations) {
  const degrees = {};
  const edgesByNode = {};
  for (const r of relations) {
    for (const node of [r.from, r.to]) {
      if (!node) continue;
      degrees[node] = (degrees[node] || 0) + 1;
      if (!edgesByNode[node]) edgesByNode[node] = [];
      edgesByNode[node].push(r);
    }
  }
  return { degrees, edgesByNode };
}

function evaluateBridgeDegrees({ relations = [], capPerNode = 8, capPerProject = null, blockMultiplier = 2 } = {}) {
  if (!Array.isArray(relations)) throw new Error('relations must be an array');
  const { degrees, edgesByNode } = _degreeIndex(relations);
  const exceedances = [];
  for (const [nodeId, degree] of Object.entries(degrees)) {
    if (degree > capPerNode) {
      exceedances.push({
        nodeId,
        degree,
        cap: capPerNode,
        excess: degree - capPerNode,
        edges: edgesByNode[nodeId],
      });
    }
  }

  let perProjectExceedances = [];
  if (capPerProject) {
    const byProject = {};
    for (const r of relations) {
      const p = r.project || 'unknown';
      byProject[p] = (byProject[p] || 0) + 1;
    }
    for (const [p, count] of Object.entries(byProject)) {
      if (count > capPerProject) {
        perProjectExceedances.push({ project: p, count, cap: capPerProject, excess: count - capPerProject });
      }
    }
  }

  const totalNodes = Object.keys(degrees).length;
  const totalEdges = relations.length;
  const sumDegree = Object.values(degrees).reduce((acc, d) => acc + d, 0);
  const maxDegree = Object.values(degrees).reduce((acc, d) => Math.max(acc, d), 0);
  const meanDegree = totalNodes ? sumDegree / totalNodes : 0;

  // Decision rule:
  //   Any node degree above cap*blockMultiplier → block (concentration
  //   too high to safely prune iteratively; needs a structural redesign).
  //   Any node above cap but below 2x → requires_pruning.
  //   Otherwise allow.
  let decision = 'allow';
  if (exceedances.length > 0) {
    const hasGross = exceedances.some((e) => e.degree > capPerNode * blockMultiplier);
    decision = hasGross ? 'block' : 'requires_pruning';
  }

  return {
    decision,
    exceedances,
    perProjectExceedances,
    summary: {
      totalNodes,
      totalEdges,
      maxDegree,
      meanDegree: Number(meanDegree.toFixed(3)),
      capPerNode,
      capPerProject,
      blockMultiplier,
    },
  };
}

function suggestPruning({ exceedances, strategy = 'oldest-first' } = {}) {
  if (!Array.isArray(exceedances)) throw new Error('exceedances must be an array');
  const proposals = [];
  for (const ex of exceedances) {
    let edges = [...ex.edges];
    if (strategy === 'oldest-first') {
      edges.sort((a, b) => {
        const ta = Date.parse(a.createdAt || 0) || 0;
        const tb = Date.parse(b.createdAt || 0) || 0;
        return ta - tb;
      });
    } else if (strategy === 'lowest-confidence') {
      edges.sort((a, b) => (a.confidence || 0) - (b.confidence || 0));
    } else if (strategy === 'random') {
      // Stable shuffle using node id seed so test output is deterministic
      // per (node, edges) combination.
      const seed = ex.nodeId.split('').reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) & 0xffff, 0);
      edges.sort((a, b) => ((seed * 7 + a.from.length) % 13) - ((seed * 7 + b.from.length) % 13));
    } else {
      throw new Error(`unknown strategy: ${strategy}`);
    }
    const edgesToRetire = edges.slice(0, ex.excess);
    proposals.push({
      nodeId: ex.nodeId,
      currentDegree: ex.degree,
      cap: ex.cap,
      edgesToRetire,
      retainedDegree: ex.degree - edgesToRetire.length,
      strategy,
    });
  }
  return proposals;
}

module.exports = {
  evaluateBridgeDegrees,
  suggestPruning,
};
