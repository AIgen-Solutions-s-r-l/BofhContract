'use strict';

/**
 * Dynamic gas-bid policy for PRIORITY-GAS-AUCTION (PGA) chains — PLAY #3.
 *
 * CONTEXT (from the 2026 MEV-viability research):
 * On a PGA chain like Monad or HyperEVM there is NO sealed-bid OFA / private orderflow to
 * plug into; inclusion priority is bought openly with the priority fee (the "gas bid"). The
 * fastest bot that bids the highest effective gas price for a given block lands the backrun.
 * This is the classic ETH-mainnet-2020 Priority Gas Auction, re-homed onto a cheap, fast,
 * under-contested L1/L2. The whole edge for fresh-pool backruns (freshPoolScanner.js) is
 * landing the tx — and that is a BIDDING problem, not a math problem.
 *
 * THE POLICY (pure, deterministic, testable):
 * We bid "just enough to win" rather than the naive "all of it":
 *   1. Never bid so much that the op turns unprofitable: bid ≤ maxBidFraction × expectedProfit.
 *   2. Bid just ABOVE the marginal competitor's observed bid (outbid by a small increment) when
 *      we have a competitor signal — winning by a hair maximises retained profit.
 *   3. Floor at the chain's base/priority fee so the tx is at least includable.
 *   4. Cap the *effective* gas price so a single op can never bleed more than the configured
 *      fraction of its own expected profit into the bid (defence vs. an irrational rival who
 *      bids to zero-EV — we walk away instead, see `shouldBid`).
 *
 * All inputs/outputs are plain numbers (gwei / USD), no bigint, no I/O — so this file is a
 * unit-test target. Wiring it to a live mempool competitor feed is a documented TODO.
 *
 * RELATIONSHIP TO gasModel.js: gasModel prices what a cycle COSTS in gas at a given gas price.
 * THIS file decides what gas price to BID. The backtester uses gasModel for cost accounting
 * and can use this policy to stress-test "what tip do we need, and is the op still GO after we
 * pay to win the auction?".
 */

// Documented policy constants. All overridable via config.gasBid.
const DEFAULTS = Object.freeze({
  // Hard ceiling: the priority bid may consume at most this fraction of expected gross profit.
  // 0.5 => we never give up more than half the edge to the auction. Above this we'd rather not
  // play (a rational searcher keeps positive EV; bidding past here is how PGAs go to zero-EV).
  maxBidFraction: 0.5,
  // When outbidding a known competitor, exceed them by this fraction (1.05 => +5%). Small, so
  // we win by a hair and keep the rest of the edge.
  outbidIncrement: 1.05,
  // Absolute minimum increment over a competitor (in gwei) when the fractional bump rounds to
  // ~0 on a tiny competitor bid — guarantees a strict outbid the sequencer will honour.
  minOutbidGwei: 0.01,
  // Assumed gas units per op when converting a USD profit budget into a gwei bid ceiling.
  // Should match the executor profile in gasModel.js you intend to ship (lean target by
  // default). Documented, overridable; the backtester passes the real hop-derived figure.
  assumedGasUnits: 150000,
  // Floor: never bid below this many gwei of priority (chain-dependent inclusion minimum).
  minPriorityGwei: 0.0,
  // Safety ceiling on the absolute bid regardless of profit, to avoid fat-finger blowups.
  absMaxPriorityGwei: 5000.0
});

/**
 * Convert a USD profit budget into the maximum priority-fee (gwei) we could pay while keeping
 * the op break-even, given gas units and the native-token USD price.
 *
 *   maxTipUsd            = profitUsd × maxBidFraction
 *   maxTipNativePerGas   = maxTipUsd / nativeUsdPrice / gasUnits     (native per gas unit)
 *   maxTipGwei           = maxTipNativePerGas × 1e9
 *
 * @param {number} expectedProfitUsd - gross expected profit of the op (before the tip).
 * @param {object} ctx - { nativeUsdPrice, gasUnits, maxBidFraction }.
 * @returns {number} ceiling in gwei (>= 0).
 */
function profitToMaxBidGwei(expectedProfitUsd, ctx) {
  const nativeUsd = Number(ctx.nativeUsdPrice || 0);
  const gasUnits = Number(ctx.gasUnits || DEFAULTS.assumedGasUnits);
  const frac = Number(ctx.maxBidFraction ?? DEFAULTS.maxBidFraction);
  if (nativeUsd <= 0 || gasUnits <= 0 || expectedProfitUsd <= 0) return 0;
  const maxTipUsd = expectedProfitUsd * frac;
  const maxTipNative = maxTipUsd / nativeUsd; // total native we can spend on the tip
  const maxTipNativePerGas = maxTipNative / gasUnits;
  return maxTipNativePerGas * 1e9; // -> gwei
}

/**
 * Decide whether an op is worth bidding on at all, given the current competitor bid.
 * If beating the competitor (by our increment) would exceed our profit-derived ceiling, the
 * auction has bid the EV away — we DECLINE (return false) rather than win unprofitably.
 *
 * @param {object} args
 * @param {number} args.expectedProfitUsd
 * @param {number} [args.competitorBidGwei=0]
 * @param {number} [args.nativeUsdPrice] - runtime native-token USD price (for the ceiling).
 * @param {number} [args.gasUnits] - op gas units (defaults to cfg.assumedGasUnits).
 * @param {object} [cfg]
 * @returns {{ shouldBid:boolean, ceilingGwei:number, requiredToWinGwei:number, reason:string }}
 */
function shouldBid(args, cfg = {}) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  // The profit->bid ceiling needs the RUNTIME market context (native USD price + gas units),
  // which travel on `args`, not on the policy cfg. Merge them so the ceiling is computed from
  // live numbers and falls back to documented defaults only when a field is omitted.
  const ctx = {
    nativeUsdPrice: args.nativeUsdPrice,
    gasUnits: args.gasUnits ?? c.assumedGasUnits,
    maxBidFraction: c.maxBidFraction
  };
  const ceiling = profitToMaxBidGwei(args.expectedProfitUsd, ctx);
  const competitor = Math.max(0, Number(args.competitorBidGwei || 0));
  const requiredToWin = competitor > 0
    ? Math.max(competitor * c.outbidIncrement, competitor + c.minOutbidGwei)
    : Math.max(c.minPriorityGwei, 0);

  if (args.expectedProfitUsd <= 0) {
    return { shouldBid: false, ceilingGwei: ceiling, requiredToWinGwei: requiredToWin, reason: 'non-positive expected profit' };
  }
  if (requiredToWin > ceiling) {
    return {
      shouldBid: false,
      ceilingGwei: ceiling,
      requiredToWinGwei: requiredToWin,
      reason: `auction bid-away: need ${requiredToWin.toFixed(4)} gwei to win > ${ceiling.toFixed(4)} gwei ceiling`
    };
  }
  return { shouldBid: true, ceilingGwei: ceiling, requiredToWinGwei: requiredToWin, reason: 'positive-EV win available' };
}

/**
 * Compute the actual priority-fee (gwei) to submit for an op on a PGA chain.
 *
 * Logic:
 *   - If we have a competitor signal: bid just above them (outbidIncrement / minOutbidGwei),
 *     but never above the profit ceiling and never below the chain floor.
 *   - If we have NO competitor signal: bid the chain floor (minPriorityGwei) — there's no one
 *     to outbid, so paying more is pure waste. (We can still land first by latency.)
 *   - Always clamp to [minPriorityGwei, min(ceiling, absMaxPriorityGwei)].
 *
 * @param {object} args
 * @param {number} args.expectedProfitUsd
 * @param {number} [args.competitorBidGwei] - observed marginal competitor priority fee (gwei).
 * @param {number} [args.nativeUsdPrice] - runtime native-token USD price (for the ceiling).
 * @param {number} [args.gasUnits] - op gas units (defaults to cfg.assumedGasUnits).
 * @param {number} [args.baseFeeGwei=0] - chain base fee (informational; bid is the *priority* tip).
 * @param {object} [cfg] - config.gasBid overrides.
 * @returns {{
 *   bidGwei:number, ceilingGwei:number, floorGwei:number,
 *   outbid:boolean, clampedToCeiling:boolean, decision:object
 * }}
 */
function computeBid(args, cfg = {}) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  const decision = shouldBid(args, c);
  const ceiling = Math.min(decision.ceilingGwei, c.absMaxPriorityGwei);
  const floor = Math.max(0, Number(c.minPriorityGwei || 0));

  if (!decision.shouldBid) {
    // Declining: return the floor as a non-binding suggestion but mark it unprofitable to win.
    return {
      bidGwei: floor,
      ceilingGwei: ceiling,
      floorGwei: floor,
      outbid: false,
      clampedToCeiling: false,
      decision
    };
  }

  const hasCompetitor = Number(args.competitorBidGwei || 0) > 0;
  let target = hasCompetitor ? decision.requiredToWinGwei : floor;

  // Clamp into [floor, ceiling].
  let clampedToCeiling = false;
  if (target > ceiling) {
    target = ceiling;
    clampedToCeiling = true;
  }
  if (target < floor) target = floor;

  return {
    bidGwei: target,
    ceilingGwei: ceiling,
    floorGwei: floor,
    outbid: hasCompetitor && !clampedToCeiling,
    clampedToCeiling,
    decision
  };
}

module.exports = {
  DEFAULTS,
  profitToMaxBidGwei,
  shouldBid,
  computeBid
};
