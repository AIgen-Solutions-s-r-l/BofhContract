'use strict';

/**
 * Stage 3 + Stage 4 — net-of-gas profit simulator and KILL/GO paper-trade harness.
 *
 * Consumes: a snapshot (scanner.js) + candidate cycles (pathfinder.js) + the gas model
 * (gasModel.js) + config thresholds. Produces a paper-trade report that decides GO vs KILL
 * BEFORE any audit spend.
 *
 * WHAT IS REAL HERE:
 *  - Per-hop CPMM output and the closed-form-ish optimal-size SEARCH are real math over the
 *    snapshot reserves (pure, offline, testable).
 *  - Net PnL subtracts per-hop fees (already in getAmountOut) AND gas+priority fee from the
 *    gas model, priced for BOTH the fat bofhV2 executor and the lean Huff target.
 *
 * WHAT IS HONESTLY MISSING (TODO before trusting a GO):
 *  - revm/Anvil re-simulation against real historical state to catch reverts, rounding,
 *    fee-on-transfer/honeypot tokens. A pure CPMM formula WILL overstate profit.
 *  - A real win-rate measured by LIVE SHADOW mode (log would-be ops, inspect next block to
 *    see if a competitor took it / it reverted). Here win-rate is a config assumption.
 *  - USD pricing of the base token leg beyond the native-token proxy.
 *
 * The kill-criteria are deliberately strict and explicit so a GO is earned, not assumed.
 */

const { ethers } = require('ethers');
const { getAmountOut } = require('./pathfinder.js');
const { gasCostForCycle, compareExecutors } = require('./gasModel.js');

/**
 * Simulate a full round-trip cycle for a given input amount.
 * @param {bigint} amountIn - base-token amount in (wei).
 * @param {Array<object>} hops - per-hop edges from the pathfinder (reserveIn/reserveOut/feeBps).
 * @returns {bigint} final base-token amount out (wei) after all hops.
 */
function simulateCycle(amountIn, hops) {
  let amt = amountIn;
  for (const h of hops) {
    amt = getAmountOut(amt, BigInt(h.reserveIn), BigInt(h.reserveOut), h.feeBps);
    if (amt <= 0n) return 0n;
  }
  return amt;
}

/**
 * Find a near-optimal input size by golden-section-free coarse+refine search.
 * (A closed-form optimum exists for 2-pool cycles and is extendable hop-by-hop — TODO to
 * implement exactly; this bounded search is robust for the skeleton and >2 hops.)
 *
 * Profit(x) = simulateCycle(x) - x is unimodal in x for CPMM cycles, so a ternary/grid
 * search converges. We grid-search in log space then refine around the best point.
 *
 * @param {Array<object>} hops
 * @param {{ maxInputWei?: bigint }} [opts]
 * @returns {{ amountIn: bigint, amountOut: bigint, grossProfitWei: bigint }}
 */
function optimalInput(hops, opts = {}) {
  if (!hops || hops.length === 0) return { amountIn: 0n, amountOut: 0n, grossProfitWei: 0n };

  // Upper bound: a fraction of the smallest base-side reserve on the first hop keeps us in
  // the regime where the cycle can be profitable (huge size always self-destructs via impact).
  const firstReserveIn = BigInt(hops[0].reserveIn);
  // Cap the search at the first hop's base-side reserve: trading more than the pool holds
  // is always self-defeating (price impact dominates). The true optimum is typically a
  // small fraction of this, so the grid below is GEOMETRIC (log-spaced) to sample the
  // profitable low region densely instead of wasting points on the deep-negative high end.
  const hardCap = opts.maxInputWei || firstReserveIn;
  if (hardCap <= 0n) return { amountIn: 0n, amountOut: 0n, grossProfitWei: 0n };

  const profitAt = (x) => {
    if (x <= 0n) return -1n;
    const out = simulateCycle(x, hops);
    return out - x;
  };

  // Geometric grid over [lo, hardCap]: x_i = lo * (hardCap/lo)^(i/steps). Profit(x) is
  // unimodal for a CPMM cycle, so the grid brackets the optimum; we refine with ternary.
  const lo = hardCap / 100000000n > 0n ? hardCap / 100000000n : 1n;
  const steps = 80;
  const loF = Number(lo);
  const ratio = Number(hardCap) / loF; // hardCap/lo as a float for exponent spacing
  let best = { amountIn: lo, profit: profitAt(lo) };
  for (let i = 1; i <= steps; i++) {
    const xF = loF * Math.pow(ratio, i / steps);
    const x = BigInt(Math.max(1, Math.round(xF)));
    const p = profitAt(x);
    if (p > best.profit) best = { amountIn: x, profit: p };
  }

  // Ternary refine in the bracket [best/4, best*4] (clamped), where Profit is unimodal.
  let left = best.amountIn / 4n > 0n ? best.amountIn / 4n : 1n;
  let right = best.amountIn * 4n < hardCap ? best.amountIn * 4n : hardCap;
  for (let iter = 0; iter < 200 && right - left > 1n; iter++) {
    const third = (right - left) / 3n;
    const m1 = left + third;
    const m2 = right - third;
    if (profitAt(m1) < profitAt(m2)) {
      left = m1 + 1n;
    } else {
      right = m2;
    }
  }
  // Pick the best of {grid winner, refined endpoints}.
  const candidatesX = [best.amountIn, left, right];
  let xStar = candidatesX[0];
  let pStar = profitAt(xStar);
  for (const x of candidatesX.slice(1)) {
    const p = profitAt(x);
    if (p > pStar) {
      pStar = p;
      xStar = x;
    }
  }
  const outStar = simulateCycle(xStar, hops);
  return { amountIn: xStar, amountOut: outStar, grossProfitWei: outStar - xStar };
}

/**
 * Convert a wei base-token amount to USD using the native-token USD price as a proxy.
 * (TODO: real per-token USD; for a wrapped-native base token this proxy is exact.)
 *
 * PRECISION: `wei` can exceed Number.MAX_SAFE_INTEGER (2^53 ≈ 9.0e15 wei), so a naive
 * `Number(wei)` would silently lose precision and corrupt the USD/PnL figure. We instead
 * format the bigint to a decimal *string* of whole tokens via ethers (scaling down by 1e18
 * exactly, in bigint) and only then convert that already-small magnitude to Number.
 * @param {bigint} wei - may be negative (e.g. a net loss).
 * @param {number} nativeUsdPrice
 * @returns {number}
 */
function weiToUsd(wei, nativeUsdPrice) {
  const tokens = Number(ethers.formatUnits(BigInt(wei), 18));
  return tokens * Number(nativeUsdPrice || 0);
}

/**
 * Evaluate a single candidate cycle: size it, simulate, and net out gas for BOTH executors.
 * @param {object} candidate - { tokens, hops, marginalEdgePct }.
 * @param {object} gasCfg - config.gas.
 * @returns {object} evaluation record.
 */
function evaluateCandidate(candidate, gasCfg) {
  const hops = candidate.hops;
  const hopCount = hops.length;
  const sized = optimalInput(hops);

  const grossUsd = weiToUsd(sized.grossProfitWei, gasCfg.nativeUsdPrice);
  const gasFat = gasCostForCycle(hopCount, gasCfg, 'bofhV2');
  const gasLean = gasCostForCycle(hopCount, gasCfg, 'leanHuff');

  const netUsdFat = grossUsd - gasFat.costUsd;
  const netUsdLean = grossUsd - gasLean.costUsd;

  return {
    tokens: candidate.tokens,
    hopCount,
    marginalEdgePct: candidate.marginalEdgePct,
    amountInWei: sized.amountIn.toString(),
    amountOutWei: sized.amountOut.toString(),
    grossProfitWei: sized.grossProfitWei.toString(),
    grossUsd,
    gasUsdFat: gasFat.costUsd,
    gasUsdLean: gasLean.costUsd,
    netUsdFat,
    netUsdLean,
    // Friction = gas (the dominant landing cost in this skeleton). priority fee already in gas.
    frictionUsd: gasFat.costUsd,
    profitableFat: netUsdFat > 0,
    profitableLean: netUsdLean > 0,
    onlyLeanProfitable: netUsdLean > 0 && netUsdFat <= 0
  };
}

/**
 * Apply explicit KILL/GO criteria to an evaluated batch and produce the verdict.
 *
 * KILL if ANY of:
 *  (1) median net-of-gas profit per profitable opportunity (fat executor) < ratio x friction;
 *  (2) realistic win-rate so low that expected daily net < infra cost;
 *  (3) the edge exists ONLY for the lean executor (fat contract never lands profitably);
 *  (4) [TODO when revm wired] revert rate exceeds maxAcceptableRevertRate.
 * GO only if none trip and there is a representative opportunity count.
 *
 * @param {object[]} evals - evaluateCandidate() records.
 * @param {object} killCfg - config.kill.
 * @param {{ windowDays?: number, revertRate?: number }} [obs] - observed run stats.
 * @returns {object} verdict report.
 */
function applyKillCriteria(evals, killCfg, obs = {}) {
  const reasons = [];
  const windowDays = obs.windowDays || 1;

  const profitableFat = evals.filter((e) => e.profitableFat);
  const profitableLean = evals.filter((e) => e.profitableLean);

  const netsFat = profitableFat.map((e) => e.netUsdFat).sort((a, b) => a - b);
  const medianNetFat = netsFat.length ? netsFat[Math.floor(netsFat.length / 2)] : 0;
  const medianFriction =
    evals.length
      ? evals.map((e) => e.frictionUsd).sort((a, b) => a - b)[Math.floor(evals.length / 2)]
      : 0;

  const opportunitiesPerDay = profitableFat.length / windowDays;
  const winRate = typeof killCfg.minWinRate === 'number' ? (obs.winRate ?? killCfg.minWinRate) : 1;
  const expectedDailyNetUsd = opportunitiesPerDay * medianNetFat * winRate;

  // (1) profit-to-friction ratio
  const ratio = killCfg.minNetProfitToFrictionRatio || 2.5;
  if (medianFriction > 0 && medianNetFat < ratio * medianFriction) {
    reasons.push(
      `KILL(1): median net profit/op $${medianNetFat.toFixed(4)} < ${ratio}x friction ` +
        `$${(ratio * medianFriction).toFixed(4)}.`
    );
  }

  // (2) daily expected net below infra cost
  const infra = killCfg.infraCostUsdPerDay || 0;
  if (expectedDailyNetUsd < infra) {
    reasons.push(
      `KILL(2): expected daily net $${expectedDailyNetUsd.toFixed(2)} < infra cost ` +
        `$${infra.toFixed(2)} (winRate=${winRate}).`
    );
  }

  // (3) edge only for lean executor
  if (profitableFat.length === 0 && profitableLean.length > 0) {
    reasons.push(
      `KILL(3): NO opportunity is profitable with the fat BofhContractV2; ` +
        `${profitableLean.length} are profitable ONLY with a lean Huff executor. ` +
        'Strip+rewrite the contract before proceeding.'
    );
  }

  // (4) revert rate (only enforced once revm is wired and obs.revertRate provided)
  if (typeof obs.revertRate === 'number') {
    const maxRevert = killCfg.maxAcceptableRevertRate ?? 0.3;
    if (obs.revertRate > maxRevert) {
      reasons.push(
        `KILL(4): revert rate ${(obs.revertRate * 100).toFixed(1)}% > ` +
          `${(maxRevert * 100).toFixed(1)}% threshold.`
      );
    }
  } else {
    reasons.push(
      'WARN: revert rate NOT measured (revm/Anvil re-simulation TODO). A GO here is ' +
        'provisional — pure CPMM math omits reverts/honeypots and overstates profit.'
    );
  }

  // Representativeness gate
  if (opportunitiesPerDay < (killCfg.minOpportunitiesPerDay || 0)) {
    reasons.push(
      `KILL(0): only ${opportunitiesPerDay.toFixed(2)} profitable ops/day < ` +
        `${killCfg.minOpportunitiesPerDay} required to be a real income stream.`
    );
  }

  const hardKills = reasons.filter((r) => r.startsWith('KILL'));
  const verdict = hardKills.length === 0 ? 'GO (PROVISIONAL)' : 'KILL';

  return {
    verdict,
    reasons,
    stats: {
      candidates: evals.length,
      profitableFat: profitableFat.length,
      profitableLean: profitableLean.length,
      medianNetUsdFat: medianNetFat,
      medianFrictionUsd: medianFriction,
      opportunitiesPerDay,
      assumedWinRate: winRate,
      expectedDailyNetUsd
    }
  };
}

/**
 * Full Stage 3+4 run over a snapshot + candidates. Pure (no I/O) so it is unit-testable.
 * @param {object} snapshot
 * @param {object[]} candidates - from pathfinder.findCandidateCycles().
 * @param {object} config - full research config (uses .gas and .kill).
 * @param {{ windowDays?: number, winRate?: number, revertRate?: number }} [obs]
 * @returns {{ evals: object[], report: object, executorComparisonSample: object }}
 */
function runBacktest(snapshot, candidates, config, obs = {}) {
  const gasCfg = config.gas || {};
  const killCfg = config.kill || {};
  const evals = candidates.map((c) => evaluateCandidate(c, gasCfg));
  const report = applyKillCriteria(evals, killCfg, obs);
  // Head-to-head fat-vs-lean gas at a representative hop count, for the strip decision.
  const sampleHops = evals.length ? evals[0].hopCount : 3;
  const executorComparisonSample = compareExecutors(sampleHops, gasCfg);
  return { evals, report, executorComparisonSample };
}

/**
 * Pretty-print a paper-trade report to stdout. Returns the same object for chaining.
 * @param {{ evals: object[], report: object, executorComparisonSample: object }} result
 * @returns {object}
 */
function printReport(result) {
  const { evals, report, executorComparisonSample } = result;
  const line = '='.repeat(72);
  console.log(`\n${line}\nPAPER-TRADE REPORT (net-of-gas) — Stage 4 KILL/GO\n${line}`);
  console.log(`candidates evaluated : ${report.stats.candidates}`);
  console.log(`profitable (fat V2)  : ${report.stats.profitableFat}`);
  console.log(`profitable (lean)    : ${report.stats.profitableLean}`);
  console.log(`median net/op (fat)  : $${report.stats.medianNetUsdFat.toFixed(4)}`);
  console.log(`median friction/op   : $${report.stats.medianFrictionUsd.toFixed(4)}`);
  console.log(`opportunities/day    : ${report.stats.opportunitiesPerDay.toFixed(2)}`);
  console.log(`assumed win-rate     : ${report.stats.assumedWinRate}`);
  console.log(`expected daily net   : $${report.stats.expectedDailyNetUsd.toFixed(2)}`);
  console.log(
    `gas fat vs lean (${executorComparisonSample.bofhV2.executor === 'bofhV2' ? '' : ''}sample` +
      ` ${evals.length ? evals[0].hopCount : 3} hops): ` +
      `fat $${executorComparisonSample.bofhV2.costUsd.toFixed(4)} vs ` +
      `lean $${executorComparisonSample.leanHuff.costUsd.toFixed(4)} ` +
      `(overhead $${executorComparisonSample.overheadUsd.toFixed(4)}/op)`
  );
  console.log(`\nVERDICT: ${report.verdict}`);
  for (const r of report.reasons) console.log(`  - ${r}`);
  console.log(line + '\n');
  return result;
}

module.exports = {
  simulateCycle,
  optimalInput,
  weiToUsd,
  evaluateCandidate,
  applyKillCriteria,
  runBacktest,
  printReport
};
