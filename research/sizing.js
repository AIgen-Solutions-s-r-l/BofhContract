'use strict';

/**
 * Liquidity-capped CPMM optimal-input sizing (PLAY #3).
 *
 * The backtester's original `optimalInput` capped the search at the FIRST hop's base-side
 * reserve and grid+ternary-searched gross profit. That is fine for fat blue-chip pools, but
 * for the fresh-pool / long-tail play it is dangerous: a brand-new pool may hold only a few
 * units of base liquidity, so the "optimum" can demand a trade that:
 *   (a) exceeds what the THINNEST hop along the cycle can absorb (not just the first hop), and
 *   (b) blows a huge price-impact crater that a CPMM-only profit number happily ignores but a
 *       real fill (and the next searcher) will not.
 *
 * This module sizes against TWO hard caps and one budget, all derived from the actual cycle:
 *   1. RESERVE CAP — input ≤ reserveCapFraction × min base-equivalent reserve across the cycle
 *      (the cycle can never route more than its thinnest pool holds).
 *   2. PRICE-IMPACT BUDGET — input ≤ the largest size whose cumulative cycle price impact
 *      stays under maxPriceImpactBps. Impact is measured as 1 - (realised rate / marginal
 *      rate) over the whole round-trip, which is the size-dependent slippage the trade self-
 *      inflicts. This is the cap that protects against fresh-pool craters.
 *   3. Within the capped interval, find the gross-profit-maximising input by the same unimodal
 *      (grid + ternary) search, since Profit(x) is unimodal for a CPMM cycle.
 *
 * Pure functions over the hop list (reserveIn/reserveOut/feeBps) + a snapshot of policy knobs.
 * No I/O. Fully testable offline. The backtester calls `optimalInputCapped` instead of any
 * naive sizing.
 *
 * NOTE on closed form: for a single 2-pool cycle there is a closed-form optimum
 *   x* = (sqrt(Ra*Rb*ka*kb) - Ra) / (something)  — exact but algebra-heavy and brittle to
 * extend past 2 hops / mixed fees. We keep the robust unimodal SEARCH (correct for n hops and
 * arbitrary fees) and add the two hard CAPS, which is what actually matters for the fresh-pool
 * play. A true closed form for the ≤5-hop case is a noted TODO upgrade, not a correctness gap.
 */

const { getAmountOut } = require('./pathfinder.js');

const DEFAULTS = Object.freeze({
  // Never route more than this fraction of the thinnest pool's base-equivalent reserve.
  reserveCapFraction: 0.3,
  // Cumulative round-trip price-impact budget, in basis points. 300 = 3%. Beyond this the
  // trade craters the pool and the edge is illusory (and a competitor front-runs the rest).
  maxPriceImpactBps: 300,
  // Grid resolution for the capped search (log-spaced), then a ternary refine.
  gridSteps: 80
});

/**
 * Round-trip output for an input over the cycle's hops (CPMM, fee-inclusive).
 * @param {bigint} amountIn
 * @param {Array<{reserveIn:string|bigint, reserveOut:string|bigint, feeBps:number}>} hops
 * @returns {bigint} final base-token out.
 */
function cycleOut(amountIn, hops) {
  let amt = amountIn;
  for (const h of hops) {
    amt = getAmountOut(amt, BigInt(h.reserveIn), BigInt(h.reserveOut), h.feeBps);
    if (amt <= 0n) return 0n;
  }
  return amt;
}

/**
 * Marginal (size→0) round-trip rate of the cycle as a float: product of fee-adjusted
 * per-hop marginal rates. Used as the impact baseline (the rate at infinitesimal size).
 * @param {Array<object>} hops
 * @returns {number} out-per-in at zero size (>1 means the cycle is marginally profitable).
 */
function marginalCycleRate(hops) {
  let rate = 1;
  for (const h of hops) {
    const rin = Number(BigInt(h.reserveIn));
    const rout = Number(BigInt(h.reserveOut));
    if (rin <= 0 || rout <= 0) return 0;
    const feeFactor = (10000 - h.feeBps) / 10000;
    rate *= feeFactor * (rout / rin);
  }
  return rate;
}

/**
 * Realised round-trip rate at a given size (out/in as a float).
 * @param {bigint} amountIn
 * @param {Array<object>} hops
 * @returns {number}
 */
function realisedRate(amountIn, hops) {
  if (amountIn <= 0n) return 0;
  const out = cycleOut(amountIn, hops);
  return Number(out) / Number(amountIn);
}

/**
 * Cumulative round-trip price impact at a given size, in basis points:
 *   impact = 1 - realisedRate / marginalRate.
 * (Marginal rate is the best-case zero-size rate; realised degrades with size.)
 * @param {bigint} amountIn
 * @param {Array<object>} hops
 * @returns {number} impact in bps (>= 0).
 */
function priceImpactBps(amountIn, hops) {
  const marg = marginalCycleRate(hops);
  if (marg <= 0) return Infinity;
  const real = realisedRate(amountIn, hops);
  const impact = 1 - real / marg;
  return Math.max(0, impact) * 10000;
}

/**
 * The base-equivalent input cap from reserves: the thinnest "input-side" reserve along the
 * cycle, scaled by reserveCapFraction. We take the minimum reserveIn across hops as a
 * conservative proxy for the cycle's absorptive capacity (a hop can't take more base-
 * equivalent than its input reserve without catastrophic impact).
 * @param {Array<object>} hops
 * @param {number} reserveCapFraction
 * @returns {bigint}
 */
function reserveCap(hops, reserveCapFraction) {
  let minReserveIn = null;
  for (const h of hops) {
    const r = BigInt(h.reserveIn);
    if (minReserveIn === null || r < minReserveIn) minReserveIn = r;
  }
  if (minReserveIn === null || minReserveIn <= 0n) return 0n;
  // Scale by fraction using bigint math (fraction in [0,1] -> per-10000 to stay integer).
  const fracBps = BigInt(Math.max(0, Math.round(reserveCapFraction * 10000)));
  return (minReserveIn * fracBps) / 10000n;
}

/**
 * Largest input whose cumulative round-trip impact stays within maxPriceImpactBps, found by
 * bisection on the (monotonically increasing) impact-vs-size curve, clamped to `hardCap`.
 * If even the hardCap is within budget, returns hardCap.
 * @param {Array<object>} hops
 * @param {bigint} hardCap
 * @param {number} maxImpactBps
 * @returns {bigint}
 */
function impactCappedInput(hops, hardCap, maxImpactBps) {
  if (hardCap <= 0n) return 0n;
  if (priceImpactBps(hardCap, hops) <= maxImpactBps) return hardCap;
  let lo = 0n;
  let hi = hardCap;
  // Bisection: impact(x) is monotonic increasing in x for a CPMM cycle.
  for (let i = 0; i < 256 && hi - lo > 1n; i++) {
    const mid = (lo + hi) / 2n;
    if (priceImpactBps(mid, hops) <= maxImpactBps) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * The liquidity-capped optimal-input sizer. Replaces naive sizing in the backtester.
 *
 * @param {Array<{reserveIn:string|bigint, reserveOut:string|bigint, feeBps:number}>} hops
 * @param {object} [cfg] - { reserveCapFraction, maxPriceImpactBps, gridSteps }.
 * @returns {{
 *   amountIn:bigint, amountOut:bigint, grossProfitWei:bigint,
 *   reserveCapWei:bigint, impactCapWei:bigint, hardCapWei:bigint,
 *   priceImpactBps:number, boundBy:'reserve'|'impact'|'interior'
 * }}
 */
function optimalInputCapped(hops, cfg = {}) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  const empty = {
    amountIn: 0n, amountOut: 0n, grossProfitWei: 0n,
    reserveCapWei: 0n, impactCapWei: 0n, hardCapWei: 0n,
    priceImpactBps: 0, boundBy: 'interior'
  };
  if (!hops || hops.length === 0) return empty;

  const rCap = reserveCap(hops, c.reserveCapFraction);
  if (rCap <= 0n) return empty;
  const iCap = impactCappedInput(hops, rCap, c.maxPriceImpactBps);
  const hardCap = iCap > 0n ? iCap : rCap;
  if (hardCap <= 0n) return { ...empty, reserveCapWei: rCap };

  const profitAt = (x) => {
    if (x <= 0n) return -1n;
    return cycleOut(x, hops) - x;
  };

  // Log-spaced grid over [lo, hardCap] then ternary refine (Profit is unimodal).
  const lo = hardCap / 100000000n > 0n ? hardCap / 100000000n : 1n;
  const steps = Math.max(8, Number(c.gridSteps || DEFAULTS.gridSteps));
  const loF = Number(lo);
  const ratio = Number(hardCap) / loF;
  let best = { amountIn: lo, profit: profitAt(lo) };
  for (let i = 1; i <= steps; i++) {
    const xF = loF * Math.pow(ratio, i / steps);
    const x = BigInt(Math.max(1, Math.round(xF)));
    const p = profitAt(x);
    if (p > best.profit) best = { amountIn: x, profit: p };
  }
  let left = best.amountIn / 4n > 0n ? best.amountIn / 4n : 1n;
  let right = best.amountIn * 4n < hardCap ? best.amountIn * 4n : hardCap;
  for (let iter = 0; iter < 200 && right - left > 1n; iter++) {
    const third = (right - left) / 3n;
    const m1 = left + third;
    const m2 = right - third;
    if (profitAt(m1) < profitAt(m2)) left = m1 + 1n;
    else right = m2;
  }
  const candidatesX = [best.amountIn, left, right];
  let xStar = candidatesX[0];
  let pStar = profitAt(xStar);
  for (const x of candidatesX.slice(1)) {
    const p = profitAt(x);
    if (p > pStar) { pStar = p; xStar = x; }
  }

  const outStar = cycleOut(xStar, hops);
  // Classify which constraint bound the result (for transparency in the report).
  let boundBy = 'interior';
  if (xStar >= hardCap - (hardCap / 1000n + 1n)) {
    boundBy = iCap < rCap ? 'impact' : 'reserve';
  }
  return {
    amountIn: xStar,
    amountOut: outStar,
    grossProfitWei: outStar - xStar,
    reserveCapWei: rCap,
    impactCapWei: iCap,
    hardCapWei: hardCap,
    priceImpactBps: priceImpactBps(xStar, hops),
    boundBy
  };
}

module.exports = {
  DEFAULTS,
  cycleOut,
  marginalCycleRate,
  realisedRate,
  priceImpactBps,
  reserveCap,
  impactCappedInput,
  optimalInputCapped
};
