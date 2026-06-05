'use strict';

/**
 * Stage 2 — Negative-cycle path-finder over a pool snapshot.
 *
 * PURE FUNCTIONS over a snapshot object (the output of scanner.js). No RPC, no I/O on the
 * hot path, so the whole stage is unit-testable offline with a hand-written snapshot.
 *
 * METHOD:
 *  - Build a directed token graph. Each pool contributes TWO directed edges (token0->token1
 *    and token1->token0). The edge weight is the negative log of the marginal, fee-adjusted
 *    exchange rate: w = -ln( (1 - fee) * reserveOut / reserveIn ).
 *  - A round-trip arbitrage cycle exists iff the product of fee-adjusted rates around the
 *    cycle > 1, i.e. the sum of edge weights < 0 (a NEGATIVE-WEIGHT CYCLE).
 *  - We run Bellman-Ford seeded at the baseToken and use the relaxation-on-the-Nth-pass
 *    trick to detect a negative cycle, then walk predecessors to recover it.
 *
 * IMPORTANT CAVEAT (baked in from the research):
 *  Bellman-Ford finds cycles using the MARGINAL (infinitesimal) rate and reports a
 *  PERCENTAGE edge. It CANNOT net out absolute gas, and the marginal rate overstates
 *  realised profit because price impact grows with trade size. Therefore this module is a
 *  CANDIDATE GENERATOR only. Final sizing + net-of-gas USD ranking happens in backtester.js.
 *
 * Constraints mirrored from the contract: cycles start and end at baseToken; hop count is
 * clamped to [minHops, maxHops] with maxHops <= MAX_PATH_LENGTH (5).
 */

/**
 * Per-hop constant-product (x*y=k) output, fee applied to input. Mirrors UniswapV2.
 * All amounts are BigInt (wei-scale). feeBps is basis points of the INPUT taken as fee.
 * @param {bigint} amountIn
 * @param {bigint} reserveIn
 * @param {bigint} reserveOut
 * @param {number} feeBps - e.g. 25 for 0.25%.
 * @returns {bigint} amountOut
 */
function getAmountOut(amountIn, reserveIn, reserveOut, feeBps) {
  if (amountIn <= 0n) return 0n;
  if (reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const feeDen = 10000n;
  const feeNum = feeDen - BigInt(feeBps); // e.g. 9975 for 0.25%
  const amountInWithFee = amountIn * feeNum;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * feeDen + amountInWithFee;
  return numerator / denominator;
}

/**
 * Marginal (size-zero) fee-adjusted rate out-per-in for an edge, as a JS number.
 * Used only for negative-cycle DETECTION; never for profit sizing.
 * @param {bigint} reserveIn
 * @param {bigint} reserveOut
 * @param {number} feeBps
 * @returns {number} effective rate; 0 if a reserve is empty.
 */
function marginalRate(reserveIn, reserveOut, feeBps) {
  if (reserveIn <= 0n || reserveOut <= 0n) return 0;
  const feeFactor = (10000 - feeBps) / 10000;
  // Use Number() on the ratio; for detection the magnitude of reserves cancels.
  return feeFactor * (Number(reserveOut) / Number(reserveIn));
}

/**
 * Build a directed graph from a snapshot.
 * @param {object} snapshot - scanner.js snapshot (must have .pools).
 * @param {{ minEdgeReserveBaseToken?: string|number }} [opts] - reserved for future filtering.
 * @returns {{ nodes: string[], edges: Array<object>, adjacency: Map<string, object[]> }}
 *   each edge: { from, to, reserveIn, reserveOut, feeBps, pair, dex, weight }
 */
function buildGraph(snapshot, opts = {}) {
  void opts; // reserved (e.g. min-liquidity pruning); kept for signature stability.
  const nodeSet = new Set();
  const edges = [];
  const adjacency = new Map();

  const addEdge = (from, to, reserveIn, reserveOut, feeBps, pair, dex) => {
    const rate = marginalRate(reserveIn, reserveOut, feeBps);
    if (rate <= 0) return; // dead/empty pool direction
    const weight = -Math.log(rate);
    const edge = { from, to, reserveIn, reserveOut, feeBps, pair, dex, weight };
    edges.push(edge);
    nodeSet.add(from);
    nodeSet.add(to);
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push(edge);
  };

  for (const p of snapshot.pools || []) {
    const r0 = BigInt(p.reserve0);
    const r1 = BigInt(p.reserve1);
    addEdge(p.token0, p.token1, r0, r1, p.feeBps, p.pair, p.dex);
    addEdge(p.token1, p.token0, r1, r0, p.feeBps, p.pair, p.dex);
  }

  return { nodes: [...nodeSet], edges, adjacency };
}

/**
 * Detect ONE negative-weight cycle reachable from `source` via Bellman-Ford.
 * Returns the cycle as an ordered list of token addresses starting and ending at the same
 * node, or null if none found within the relaxation bound.
 * @param {{ nodes:string[], edges:object[] }} graph
 * @param {string} source
 * @returns {string[]|null}
 */
function findNegativeCycleFrom(graph, source) {
  const dist = new Map();
  const pred = new Map();
  for (const n of graph.nodes) dist.set(n, Infinity);
  if (!dist.has(source)) return null;
  dist.set(source, 0);

  const V = graph.nodes.length;

  // Phase 1: |V|-1 relaxation passes. `anyRelaxed` drives the early-exit optimisation;
  // it is INDEPENDENT of negative-cycle detection (which happens in phase 2). A 3-node
  // graph can host a 3-edge cycle that needs all |V|-1 passes to propagate, so we must
  // not conflate "no node relaxed" with "no negative cycle".
  for (let i = 0; i < V - 1; i++) {
    let anyRelaxed = false;
    for (const e of graph.edges) {
      const du = dist.get(e.from);
      if (du === Infinity) continue;
      const nd = du + e.weight;
      if (nd < dist.get(e.to) - 1e-12) {
        dist.set(e.to, nd);
        pred.set(e.to, e.from);
        anyRelaxed = true;
      }
    }
    if (!anyRelaxed) break; // distances converged => no negative cycle reachable
  }

  // Phase 2: one more pass. Any edge that still relaxes sits on (or downstream of) a
  // negative-weight cycle.
  let relaxedNode = null;
  for (const e of graph.edges) {
    const du = dist.get(e.from);
    if (du === Infinity) continue;
    if (du + e.weight < dist.get(e.to) - 1e-12) {
      pred.set(e.to, e.from);
      relaxedNode = e.to;
      break;
    }
  }

  if (relaxedNode === null) return null;

  // Walk predecessors V times to land squarely inside the cycle, then extract it.
  let cur = relaxedNode;
  for (let i = 0; i < V; i++) cur = pred.get(cur);

  const cycle = [cur];
  let node = pred.get(cur);
  while (node !== undefined && node !== cur) {
    cycle.push(node);
    node = pred.get(node);
  }
  cycle.push(cur);
  cycle.reverse();
  return cycle;
}

/**
 * Rotate a raw cycle so it starts (and ends) at baseToken, if baseToken is part of it.
 * @param {string[]} cycle - closed walk (first === last).
 * @param {string} baseToken
 * @returns {string[]|null} rotated closed walk anchored at baseToken, or null.
 */
function anchorCycleAtBase(cycle, baseToken) {
  if (!cycle || cycle.length < 3) return null;
  const open = cycle.slice(0, -1); // drop duplicate tail
  const idx = open.findIndex((t) => t.toLowerCase() === baseToken.toLowerCase());
  if (idx === -1) return null;
  const rotated = open.slice(idx).concat(open.slice(0, idx));
  rotated.push(rotated[0]); // re-close
  return rotated;
}

/**
 * For an anchored token cycle, resolve the concrete pool/edge per hop, preferring the edge
 * with the best marginal rate when several forks connect the same pair.
 * @param {{ adjacency: Map<string, object[]> }} graph
 * @param {string[]} tokenCycle - anchored closed walk (first === last).
 * @returns {Array<object>|null} per-hop edges, or null if any hop has no edge.
 */
function resolveCycleEdges(graph, tokenCycle) {
  const hops = [];
  for (let i = 0; i < tokenCycle.length - 1; i++) {
    const from = tokenCycle[i];
    const to = tokenCycle[i + 1];
    const candidates = (graph.adjacency.get(from) || []).filter((e) => e.to === to);
    if (candidates.length === 0) return null;
    // Pick the most favourable fork for this hop (lowest weight = best rate).
    candidates.sort((a, b) => a.weight - b.weight);
    hops.push(candidates[0]);
  }
  return hops;
}

/**
 * Find candidate profitable round-trip cycles anchored at baseToken.
 *
 * Strategy: repeatedly find a negative cycle, anchor it at baseToken, record it, then
 * "break" its best edge (mark it used) and retry, up to `topN` candidates. This is a
 * pragmatic enumeration — NOT exhaustive — sufficient for a candidate generator. A
 * production version would use Johnson's algorithm or line-graph MMBF for completeness.
 *
 * @param {object} snapshot
 * @param {object} [cfg] - pathfinder config block: { maxHops, minHops, topN }.
 * @returns {Array<{ tokens:string[], hops:object[], marginalEdgePct:number }>}
 */
function findCandidateCycles(snapshot, cfg = {}) {
  const baseToken = snapshot.baseToken;
  if (!baseToken) {
    console.warn('[pathfinder] snapshot.baseToken is null — set it in the snapshot/config. No cycles.');
    return [];
  }
  const maxHops = cfg.maxHops || 5;
  const minHops = cfg.minHops || 2;
  const topN = cfg.topN || 50;

  const graph = buildGraph(snapshot);
  const results = [];
  const usedEdgeKeys = new Set();

  const edgeKey = (e) => `${e.pair}:${e.from}->${e.to}`;

  for (let attempt = 0; attempt < topN * 4 && results.length < topN; attempt++) {
    // Rebuild a working graph excluding already-consumed edges so we surface new cycles.
    const workEdges = graph.edges.filter((e) => !usedEdgeKeys.has(edgeKey(e)));
    if (workEdges.length === 0) break;
    const workAdj = new Map();
    for (const e of workEdges) {
      if (!workAdj.has(e.from)) workAdj.set(e.from, []);
      workAdj.get(e.from).push(e);
    }
    const workGraph = { nodes: graph.nodes, edges: workEdges, adjacency: workAdj };

    const rawCycle = findNegativeCycleFrom(workGraph, baseToken);
    if (!rawCycle) break;

    const anchored = anchorCycleAtBase(rawCycle, baseToken);
    if (!anchored) {
      // Cycle didn't touch base; consume its edges anyway to make progress.
      const edges = resolveCycleEdges(workGraph, rawCycle);
      if (edges) edges.forEach((e) => usedEdgeKeys.add(edgeKey(e)));
      continue;
    }

    const hops = resolveCycleEdges(workGraph, anchored);
    if (!hops) continue;

    const hopCount = hops.length;
    // Consume the best (lowest-weight) edge so the next attempt explores elsewhere.
    const breakEdge = hops.slice().sort((a, b) => a.weight - b.weight)[0];
    usedEdgeKeys.add(edgeKey(breakEdge));

    if (hopCount < minHops || hopCount > maxHops) continue;

    // Marginal (size-zero) edge as a percentage: product of rates - 1.
    const logSum = hops.reduce((s, e) => s + e.weight, 0);
    const marginalEdgePct = (Math.exp(-logSum) - 1) * 100;
    if (marginalEdgePct <= 0) continue;

    results.push({ tokens: anchored, hops, marginalEdgePct });
  }

  // Best marginal edge first (final ranking by absolute USD is the backtester's job).
  results.sort((a, b) => b.marginalEdgePct - a.marginalEdgePct);
  return results;
}

module.exports = {
  getAmountOut,
  marginalRate,
  buildGraph,
  findNegativeCycleFrom,
  anchorCycleAtBase,
  resolveCycleEdges,
  findCandidateCycles
};
