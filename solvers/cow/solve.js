'use strict';

/**
 * CoW Protocol solver engine — SCAFFOLD.
 *
 * WHAT THIS IS: the "solver engine" half of a CoW solver (the other half, the "driver", is
 * CoW infrastructure managed for bonding-pool members — we do NOT implement it). The driver
 * POSTs a batch auction to our engine at  {base}/${env}/${network}/solve  and expects a
 * { "solutions": [...] } body back. This file implements that solve() transform, plus a tiny
 * stdin/--demo harness so it is runnable offline with `node solvers/cow/solve.js --demo`.
 *
 * WHAT IS REAL vs TODO:
 *   REAL: auction parsing, the allowlist gate, the route->interaction encoding (settlement.js),
 *         net-of-gas scoring reusing research/backtester.js + gasModel.js, the CoW solution shape.
 *   TODO(real): an actual HTTP server the driver can reach (no web framework installed — see
 *               README); a real route over LIVE reserves (here we expect a snapshot to be
 *               provided, mirroring research/run.js, because scanner.js needs RPC); the
 *               token-safety simulator gate; driver auth; submission keys.
 *
 * IMPORTANT HONESTY (mirrors the research DISCIPLINE): this scaffold does NOT prove an edge.
 * It is wiring. A solution is only emitted when net-of-gas surplus clears config.scoring, and
 * the whole thing is gated on KYC + a Gate-0-style live-OFA check (see README). It is not a
 * turnkey money printer.
 */

const fs = require('fs');
const path = require('path');

// We are allowed to READ research/* to mirror interfaces. We reuse the path-finding +
// net-of-gas scoring engines verbatim rather than reimplementing them.
const { findCandidateCycles } = require('../../research/pathfinder.js');
const { optimalInput, weiToUsd } = require('../../research/backtester.js');
const { gasCostForCycle } = require('../../research/gasModel.js');
const { buildBofhInteractions } = require('./settlement.js');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const EXAMPLE_PATH = path.join(__dirname, 'config.example.json');

/**
 * Load solver config, preferring config.json, falling back to the committed example so the
 * scaffold is inspectable out of the box.
 * @returns {{ config: object, isExample: boolean }}
 */
function loadConfig() {
  const usingExample = !fs.existsSync(CONFIG_PATH);
  const raw = fs.readFileSync(usingExample ? EXAMPLE_PATH : CONFIG_PATH, 'utf8');
  if (usingExample) {
    console.warn('[cow/solve] config.json not found — using config.example.json (placeholders). Copy + fill before any real run.');
  }
  return { config: JSON.parse(raw), isExample: usingExample };
}

/**
 * Lowercase-set of allowlisted tokens. Fail-closed: empty allowlist solves nothing.
 * @param {object} config
 * @returns {Set<string>}
 */
function allowSet(config) {
  const toks = (config.tokenAllowlist && config.tokenAllowlist.tokens) || [];
  return new Set(toks.map((t) => String(t).toLowerCase()));
}

/**
 * Gate an order through the token allowlist (the off-chain analogue of the token-safety
 * simulator from the research report).
 * @param {object} order - CoW Order (uid, sellToken, buyToken, ...).
 * @param {Set<string>} allow
 * @returns {boolean}
 */
function orderPassesAllowlist(order, allow) {
  if (allow.size === 0) return false;
  return allow.has(String(order.sellToken).toLowerCase()) && allow.has(String(order.buyToken).toLowerCase());
}

/**
 * Route a single order over the V2-fork registry using the pathfinder.
 *
 * MIRROR-OF-INTERFACE NOTE: research/pathfinder.findCandidateCycles is a baseToken-anchored
 * CYCLE finder (arb), not a generic A->B router. For this scaffold we therefore solve the case
 * the contract supports today: orders/backruns whose sell and buy token are the configured
 * baseToken leg, surfacing the most profitable round-trip cycle through the snapshot. Building
 * a true sell->buy router (and a contract that accepts it) is a flagged TODO (see README/
 * settlement.js). We DO NOT fabricate a route for an arbitrary pair — we return null and skip.
 *
 * @param {object} order
 * @param {object} snapshot - scanner.js-shaped pool snapshot (REAL reserves required for truth).
 * @param {object} config
 * @returns {null | { tokens:string[], hops:object[], amountInWei:string, amountOutWei:string,
 *                    minAmountOutWei:string, grossProfitWei:string }}
 */
function routeOrder(order, snapshot, config) {
  const baseToken = String(snapshot.baseToken || '').toLowerCase();
  const sell = String(order.sellToken).toLowerCase();
  const buy = String(order.buyToken).toLowerCase();

  // Only the baseToken<->baseToken case is honestly settlable by BofhContractV2 today.
  if (!baseToken || sell !== baseToken || buy !== baseToken) {
    return null;
  }

  const candidates = findCandidateCycles(snapshot, config.pathfinder || {});
  if (candidates.length === 0) return null;

  // Score by net-of-gas later; here pick the best-sized candidate as the route for this order.
  let best = null;
  for (const c of candidates) {
    const sized = optimalInput(c.hops);
    if (sized.grossProfitWei <= 0n) continue;
    if (!best || sized.grossProfitWei > BigInt(best.grossProfitWei)) {
      best = {
        tokens: c.tokens,
        hops: c.hops,
        amountInWei: sized.amountIn.toString(),
        amountOutWei: sized.amountOut.toString(),
        grossProfitWei: sized.grossProfitWei.toString()
      };
    }
  }
  if (!best) return null;

  // On-chain economic backstop: minAmountOut. By default we set it to amountIn — i.e. the
  // contract only enforces that the route round-trips WHOLE (break-even, no on-chain profit
  // floor). This is DELIBERATE: the REAL economic guard is the solver's OFF-CHAIN net-of-gas
  // scoring (scoreRoute below). CoW will not submit a solution that loses, and a winning
  // solution has already cleared config.scoring.minNetSurplusUsd before it is ever encoded, so
  // the chain only needs to guard against a stale-reserve revert (out < in), not against a
  // losing trade. Optionally tighten this with config.scoring.minOnchainProfitBps to also
  // demand an on-chain profit floor (bps over amountIn) as defence-in-depth against bad
  // off-chain scoring — 0 (break-even) by default.
  const profitBps = BigInt((config.scoring && config.scoring.minOnchainProfitBps) || 0);
  const amountIn = BigInt(best.amountInWei);
  best.minAmountOutWei = (amountIn + (amountIn * profitBps) / 10000n).toString();
  return best;
}

/**
 * Net-of-gas score for a route, reusing the research gas model. Returns USD surplus after gas.
 * @param {object} route
 * @param {object} config
 * @returns {{ grossUsd:number, gasUsd:number, netUsd:number, hopCount:number }}
 */
function scoreRoute(route, config) {
  const gasCfg = config.gas || {};
  const hopCount = route.hops.length;
  const grossUsd = weiToUsd(BigInt(route.grossProfitWei), gasCfg.nativeUsdPrice);
  // Fat executor: BofhContractV2 is the interaction contract, so price its gas (not lean).
  const gas = gasCostForCycle(hopCount, gasCfg, 'bofhV2');
  return { grossUsd, gasUsd: gas.costUsd, netUsd: grossUsd - gas.costUsd, hopCount };
}

/**
 * Assemble a CoW Solution object for one fulfilled order + its Bofh interactions.
 * Shape mirrors the solver openapi.yml: { id, prices, trades:[{kind:"fulfillment",...}],
 * interactions:[{kind:"custom",...}], gas }.
 * @param {number} id
 * @param {object} order
 * @param {object} route
 * @param {object} score
 * @param {object} config
 * @param {number} deadline - unix seconds
 * @returns {object} CoW Solution
 */
function buildSolution(id, order, route, score, config, deadline) {
  const interactionContract = (config.interactionContract || {}).address;
  const interactions = buildBofhInteractions(route, {
    interactionContract,
    deadline,
    includeApprove: true,
    useRegistryFees: true
  });

  // Clearing prices: for the baseToken round-trip the in/out token is the same; a 1:1 price
  // entry is the minimal valid map. A real multi-token fill must price every traded token so
  // CoW can verify uniform clearing (TODO when generic routing lands).
  const prices = { [order.sellToken]: '1', [order.buyToken]: '1' };

  return {
    id,
    prices,
    trades: [
      {
        kind: 'fulfillment',
        order: order.uid,
        // sell-kind orders report executed SELL amount; buy-kind report executed BUY amount.
        executedAmount: String(order.kind === 'buy' ? order.buyAmount : order.sellAmount)
      }
    ],
    interactions,
    // Estimated gas units for the whole interaction set (fat executor profile).
    gas: gasCostForCycle(score.hopCount, config.gas || {}, 'bofhV2').gasUnits,
    // Non-standard annotation for our own logs/inspection — CoW ignores unknown fields.
    _bofhNetUsd: Number(score.netUsd.toFixed(6))
  };
}

/**
 * Parse + solve a CoW batch auction instance.
 *
 * @param {object} auction - CoW auction (id, tokens, orders[], effectiveGasPrice, deadline, ...).
 * @param {object} ctx
 * @param {object} ctx.config - solver config (see config.example.json).
 * @param {object} ctx.snapshot - scanner.js-shaped pool snapshot (REAL reserves for a real run).
 * @returns {{ solutions: object[] }} the CoW solution response body.
 */
function solve(auction, ctx) {
  const { config, snapshot } = ctx;
  if (!auction || !Array.isArray(auction.orders)) {
    throw new Error('solve: auction.orders missing — not a CoW batch-auction instance.');
  }
  if (!snapshot) {
    // Honest about the dependency: we route over reserves; without them there is nothing to do.
    console.warn('[cow/solve] no pool snapshot provided — cannot route. (scanner.js needs RPC; see README.) Returning empty.');
    return { solutions: [] };
  }

  const allow = allowSet(config);
  const minNet = (config.scoring && config.scoring.minNetSurplusUsd) || 0;
  // CoW deadline is ISO-8601; fall back to +60s. The contract reverts past this.
  const deadline = auction.deadline
    ? Math.floor(new Date(auction.deadline).getTime() / 1000)
    : Math.floor(Date.now() / 1000) + 60;

  const solutions = [];
  let nextId = 0;

  for (const order of auction.orders) {
    if (!orderPassesAllowlist(order, allow)) continue; // token-safety gate (fail closed)

    const route = routeOrder(order, snapshot, config);
    if (!route) continue;

    const score = scoreRoute(route, config);
    if (score.netUsd <= 0 || score.netUsd < minNet) continue; // net-of-gas scorer is the gate

    try {
      solutions.push(buildSolution(nextId++, order, route, score, config, deadline));
    } catch (err) {
      // A bad encode (e.g. zero interaction-contract address) must NEVER yield a fake solution.
      console.warn(`[cow/solve] skipped order ${order.uid}: ${err.message}`);
    }
  }

  return { solutions };
}

/* --------------------------------------------------------------------------------------- *
 * Runnable harness: `node solvers/cow/solve.js --demo`  builds a synthetic auction + the
 * research demo snapshot and prints the solution JSON. No RPC, no driver, no keys.
 * --------------------------------------------------------------------------------------- */

/**
 * Demo CoW auction whose single order is a baseToken round-trip over the research demo
 * snapshot (so the cycle finder yields a route). Tokens are forced onto the allowlist.
 * @param {object} snapshot
 * @returns {object} auction
 */
function demoAuction(snapshot) {
  const base = snapshot.baseToken;
  return {
    id: 'demo-auction-1',
    tokens: { [base]: { decimals: 18, symbol: snapshot.baseTokenSymbol || 'WBASE' } },
    orders: [
      {
        uid: '0x' + 'ab'.repeat(56),
        sellToken: base,
        buyToken: base,
        sellAmount: (10n ** 18n).toString(),
        buyAmount: (10n ** 18n).toString(),
        fullBuyAmount: (10n ** 18n).toString(),
        kind: 'sell',
        partiallyFillable: false,
        class: 'limit',
        owner: '0x' + '11'.repeat(20),
        validTo: Math.floor(Date.now() / 1000) + 3600,
        signingScheme: 'eip712'
      }
    ],
    effectiveGasPrice: '60000000', // 0.06 gwei, wei
    deadline: new Date(Date.now() + 60_000).toISOString()
  };
}

function mainDemo() {
  const { config } = loadConfig();
  // Reuse the research demo snapshot so the cycle finder has something to chew on.
  const { demoSnapshot } = require('../../research/run.js');
  const snapshot = demoSnapshot();

  // Force the demo tokens onto the allowlist + a non-zero interaction contract so the
  // scaffold can produce a sample solution end-to-end without real config.
  const cfg = JSON.parse(JSON.stringify(config));
  cfg.tokenAllowlist = { tokens: [snapshot.baseToken] };
  cfg.interactionContract = { address: '0x' + '22'.repeat(20) };

  const auction = demoAuction(snapshot);
  const out = solve(auction, { config: cfg, snapshot });

  console.log('[cow/solve --demo] auction orders:', auction.orders.length);
  console.log('[cow/solve --demo] solutions:', out.solutions.length);
  console.log(JSON.stringify(out, null, 2));
  if (out.solutions.length === 0) {
    console.log('\n[cow/solve --demo] NOTE: 0 solutions is a valid outcome (net-of-gas gate / demo reserves).');
  }
}

if (require.main === module) {
  const arg = process.argv[2];
  try {
    if (arg === '--demo') {
      mainDemo();
    } else if (arg) {
      // Treat a positional arg as a path to a CoW auction JSON; snapshot via env SNAPSHOT_FILE.
      const { config } = loadConfig();
      const auction = JSON.parse(fs.readFileSync(arg, 'utf8'));
      const snapFile = process.env.SNAPSHOT_FILE;
      const snapshot = snapFile ? JSON.parse(fs.readFileSync(snapFile, 'utf8')) : null;
      console.log(JSON.stringify(solve(auction, { config, snapshot }), null, 2));
    } else {
      console.log('usage: node solvers/cow/solve.js --demo   |   node solvers/cow/solve.js <auction.json>  (SNAPSHOT_FILE=<snapshot.json>)');
    }
  } catch (err) {
    console.error('[cow/solve] fatal:', err.message);
    process.exitCode = 1;
  }
}

module.exports = {
  loadConfig,
  allowSet,
  orderPassesAllowlist,
  routeOrder,
  scoreRoute,
  buildSolution,
  solve,
  demoAuction
};
