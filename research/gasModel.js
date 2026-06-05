'use strict';

/**
 * Gas model for net-of-gas PnL.
 *
 * WHY THIS FILE EXISTS (the strip decision must be data-driven):
 * The 6-expert panel's core quantitative claim is that the current BofhContractV2
 * executor burns ~2-3x the gas of a lean Huff/Yul atomic executor, and that this alone
 * can erase the long-tail arbitrage edge. The backtester prices EVERY candidate against
 * BOTH executors so the team can see, in USD, how much edge the fat contract destroys.
 * If cycles are profitable ONLY for the lean executor, that is a partial KILL signal for
 * the current contract (strip it) rather than for the strategy.
 *
 * ALL CONSTANTS BELOW ARE PLACEHOLDER ESTIMATES — TODO: replace with measured numbers.
 *  - bofhV2: run `REPORT_GAS=true npx hardhat test` and read executeSwap gas per path
 *    length, OR trace a real testnet executeSwap. Record base overhead + per-hop cost.
 *  - leanHuff: take from a public Huff/Yul V2 multi-hop executor benchmark
 *    (e.g. pawelurbanek.com/mev-yul-huff-gas) or a target you intend to build to.
 * The numbers here are deliberately conservative round figures so nobody mistakes them
 * for measurements.
 */

const { ethers } = require('ethers');

// Gas profiles: { baseGas, perHopGas }. Total = baseGas + perHopGas * hops, where
// `hops` = number of swaps in the cycle = path.length - 1.
const EXECUTOR_PROFILES = {
  // TODO(measure): BofhContractV2 — fat Solidity executor (current asset). Placeholder.
  bofhV2: {
    label: 'BofhContractV2 (current, fat)',
    baseGas: 120000,
    perHopGas: 95000,
    source: 'PLACEHOLDER — measure via REPORT_GAS=true npx hardhat test'
  },
  // TODO(measure): lean Huff/Yul target the team would rewrite to. Placeholder.
  leanHuff: {
    label: 'Lean Huff/Yul (target)',
    baseGas: 40000,
    perHopGas: 38000,
    source: 'PLACEHOLDER — from public Huff/Yul V2 executor benchmark'
  }
};

const GWEI = 1e9;

/**
 * Estimate gas units for a cycle on a given executor.
 * @param {number} hops - number of swaps in the cycle (path.length - 1).
 * @param {string} [executor="bofhV2"] - key in EXECUTOR_PROFILES.
 * @returns {number} estimated gas units.
 */
function estimateGasUnits(hops, executor = 'bofhV2') {
  const profile = EXECUTOR_PROFILES[executor];
  if (!profile) {
    throw new Error(`Unknown executor "${executor}". Known: ${Object.keys(EXECUTOR_PROFILES).join(', ')}`);
  }
  if (!Number.isInteger(hops) || hops < 1) {
    throw new Error(`hops must be a positive integer, got ${hops}`);
  }
  return profile.baseGas + profile.perHopGas * hops;
}

/**
 * Total per-tx gas price in wei, including the priority fee (tip) the searcher must pay
 * for inclusion. On private-relay chains (48 Club / bloXroute on BSC) treat priorityFee
 * as the bribe; raise it in config to stress-test inclusion cost.
 * @param {{ baseFeeGwei: number, priorityFeeGwei: number }} gasCfg
 * @returns {number} effective gas price in wei.
 */
function effectiveGasPriceWei(gasCfg) {
  const base = Number(gasCfg.baseFeeGwei || 0);
  const tip = Number(gasCfg.priorityFeeGwei || 0);
  return Math.round((base + tip) * GWEI);
}

/**
 * Full per-cycle gas cost, in native wei and in USD, for a given executor.
 * @param {number} hops
 * @param {{ baseFeeGwei:number, priorityFeeGwei:number, nativeUsdPrice:number }} gasCfg
 * @param {string} [executor="bofhV2"]
 * @returns {{ gasUnits:number, gasPriceWei:number, costWei:bigint, costNative:number, costUsd:number, executor:string }}
 */
function gasCostForCycle(hops, gasCfg, executor = 'bofhV2') {
  const gasUnits = estimateGasUnits(hops, executor);
  const gasPriceWei = effectiveGasPriceWei(gasCfg);
  const costWei = BigInt(gasUnits) * BigInt(gasPriceWei);
  // PRECISION: costWei can exceed 2^53, so scale the bigint down by 1e18 exactly (as a
  // decimal string via ethers) before converting to Number, instead of Number(costWei)/1e18.
  const costNative = Number(ethers.formatEther(costWei));
  const nativeUsd = Number(gasCfg.nativeUsdPrice || 0);
  const costUsd = costNative * nativeUsd;
  return { gasUnits, gasPriceWei, costWei, costNative, costUsd, executor };
}

/**
 * Convenience: price a cycle against BOTH executors so the strip decision is explicit.
 * @param {number} hops
 * @param {object} gasCfg
 * @returns {{ bofhV2: object, leanHuff: object, overheadUsd: number }}
 */
function compareExecutors(hops, gasCfg) {
  const bofhV2 = gasCostForCycle(hops, gasCfg, 'bofhV2');
  const leanHuff = gasCostForCycle(hops, gasCfg, 'leanHuff');
  return { bofhV2, leanHuff, overheadUsd: bofhV2.costUsd - leanHuff.costUsd };
}

module.exports = {
  EXECUTOR_PROFILES,
  estimateGasUnits,
  effectiveGasPriceWei,
  gasCostForCycle,
  compareExecutors
};
