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
const { optimalInputCapped } = require('./sizing.js');
const { checkToken } = require('./tokenSafety.js');

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
 * Find a near-optimal input size, HARD-CAPPED by pool reserves and a max-price-impact budget.
 *
 * This now delegates to sizing.optimalInputCapped (PLAY #3): the old version capped only at
 * the FIRST hop's reserve and ignored price impact, which over-sizes catastrophically in thin
 * fresh pools. The capped sizer bounds the input by (a) reserveCapFraction × the THINNEST
 * hop's input reserve and (b) the largest size whose cumulative round-trip impact stays under
 * maxPriceImpactBps, then maximises gross profit (unimodal grid+ternary) inside that interval.
 *
 * Backward-compatible shape: returns { amountIn, amountOut, grossProfitWei } plus extra
 * cap/impact fields the evaluator surfaces. `opts.sizingCfg` overrides the sizing knobs
 * (config.sizing). `opts.maxInputWei` (legacy) further tightens the reserve cap if smaller.
 *
 * @param {Array<object>} hops
 * @param {{ maxInputWei?: bigint, sizingCfg?: object }} [opts]
 * @returns {{ amountIn:bigint, amountOut:bigint, grossProfitWei:bigint,
 *   reserveCapWei:bigint, impactCapWei:bigint, hardCapWei:bigint,
 *   priceImpactBps:number, boundBy:string }}
 */
function optimalInput(hops, opts = {}) {
  if (!hops || hops.length === 0) {
    return {
      amountIn: 0n, amountOut: 0n, grossProfitWei: 0n,
      reserveCapWei: 0n, impactCapWei: 0n, hardCapWei: 0n, priceImpactBps: 0, boundBy: 'interior'
    };
  }
  const sized = optimalInputCapped(hops, opts.sizingCfg || {});
  // Legacy explicit ceiling (API stability): if the caller passed a tighter maxInputWei than
  // the sizer's chosen optimum, clamp the input down to it and recompute the output. Profit(x)
  // is unimodal and the cap sits left of the optimum, so the clamped point is the best feasible
  // input under the explicit ceiling.
  if (opts.maxInputWei) {
    const cap = BigInt(opts.maxInputWei);
    if (cap > 0n && sized.amountIn > cap) {
      const out = simulateCycle(cap, hops);
      return { ...sized, amountIn: cap, amountOut: out, grossProfitWei: out - cap, hardCapWei: cap, boundBy: 'explicit' };
    }
  }
  return sized;
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
 * Evaluate a single candidate cycle: size it (liquidity- + impact-capped), simulate, and net
 * out gas for BOTH executors.
 * @param {object} candidate - { tokens, hops, marginalEdgePct }.
 * @param {object} gasCfg - config.gas.
 * @param {object} [sizingCfg] - config.sizing (reserveCapFraction, maxPriceImpactBps).
 * @returns {object} evaluation record.
 */
function evaluateCandidate(candidate, gasCfg, sizingCfg = {}) {
  const hops = candidate.hops;
  const hopCount = hops.length;
  const sized = optimalInput(hops, { sizingCfg });

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
    // PLAY #3 sizing transparency: which constraint bound the size + realised impact.
    sizeBoundBy: sized.boundBy,
    priceImpactBps: sized.priceImpactBps,
    reserveCapWei: sized.reserveCapWei.toString(),
    impactCapWei: sized.impactCapWei.toString(),
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
 * For a candidate cycle, enumerate EACH distinct non-base token T and (where derivable) a
 * clean-CPMM base<->token baseline for the token-safety guard's PER-TOKEN probe (PLAY #4).
 *
 * SEMANTICS FIX (was apples-to-oranges): the token-safety probe is a 2-hop base<->token
 * round-trip (base->T->base), NOT a measurement over a whole >2-hop cycle. So a token's
 * baseline must come from a hop that pairs T DIRECTLY with the base token, never from interior
 * token-to-token hops of a longer cycle (those are different pools with their own fee/impact —
 * comparing the live base<->token quote against them would fabricate a meaningless "tax").
 *
 *   - buyPool  is set ONLY from a hop base->T  (from===base, to===T).
 *   - sellPool is set ONLY from a hop T->base  (from===T,   to===base).
 * If a token is paired directly with base on the cycle (the typical first/last leg of a
 * baseToken-anchored cycle), both are available and tax is measurable apples-to-apples. For an
 * INTERIOR token with no direct base pairing on this cycle, we have no base<->token reserves
 * offline → buyPool/sellPool are left null. The guard then SKIPS the (unmeasurable) tax math
 * for that token but STILL runs the live honeypot / sell-revert probe (which needs no baseline
 * and applies to every non-base token regardless of cycle position). Obtaining the interior
 * token's real base<->token reserves for an offline tax baseline is a TODO (needs a pool
 * lookup / RPC); live mode covers the honeypot signal today.
 *
 * @param {object} candidate - { tokens, hops }.
 * @param {string} baseToken
 * @returns {Array<{ token:string, buyPool:(object|null), sellPool:(object|null), directBasePair:boolean }>}
 */
function tokenSafetyTargets(candidate, baseToken) {
  const hops = candidate.hops;
  const baseKey = baseToken.toLowerCase();
  const out = [];
  // A token T's base<->token BUY pool is a hop base->T; its base<->token SELL pool is T->base.
  const buyFromBase = new Map(); // T -> hop (base -> T)
  const sellToBase = new Map(); // T -> hop (T -> base)
  for (const h of hops) {
    const fromKey = h.from.toLowerCase();
    const toKey = h.to.toLowerCase();
    if (fromKey === baseKey && toKey !== baseKey) buyFromBase.set(toKey, h);
    if (toKey === baseKey && fromKey !== baseKey) sellToBase.set(fromKey, h);
  }
  const seen = new Set();
  for (const h of hops) {
    for (const t of [h.from, h.to]) {
      const key = t.toLowerCase();
      if (key === baseKey || seen.has(key)) continue;
      seen.add(key);
      const buyHop = buyFromBase.get(key);
      const sellHop = sellToBase.get(key);
      const directBasePair = !!(buyHop && sellHop);
      out.push({
        token: t,
        // BUY pool (base->T): base-side=reserveIn, token-side=reserveOut. Null unless T is
        // directly paired with base on this cycle (apples-to-apples baseline requirement).
        buyPool: directBasePair
          ? { reserveBase: BigInt(buyHop.reserveIn), reserveToken: BigInt(buyHop.reserveOut), feeBps: buyHop.feeBps }
          : null,
        // SELL pool (T->base): token-side=reserveIn, base-side=reserveOut.
        sellPool: directBasePair
          ? { reserveToken: BigInt(sellHop.reserveIn), reserveBase: BigInt(sellHop.reserveOut), feeBps: sellHop.feeBps }
          : null,
        directBasePair
      });
    }
  }
  return out;
}

/**
 * HARD token-safety GATE (PLAY #4) applied BEFORE a candidate is evaluated/fired.
 *
 * For EACH distinct non-base token on the cycle, run the PER-TOKEN base<->token buy-then-sell
 * probe (tokenSafety.checkToken) INDEPENDENTLY. A candidate is DROPPED if ANY one of its
 * tokens fails (honeypot / sell-block / over-limit transfer tax / max-tx). This is a per-token
 * 2-hop probe, not a single whole-cycle measurement: a 3–5 hop cycle is only as safe as its
 * most dangerous token, and the honeypot/sell-revert signal (which needs no CPMM baseline)
 * covers interior tokens too. Dropped candidates are COUNTED and never evaluated.
 *
 * MODES:
 *  - Live: pass `opts.provider` (+ `opts.router` for getAmountsOut). The guard runs the real
 *    eth_call round-trip per token. This is async.
 *  - Offline (demo/tests): with no provider, the guard has no real round-trip data, so by
 *    policy it does NOT hard-fail clean tokens (it only fails on POSITIVE evidence). This keeps
 *    the offline pipeline runnable while the gate is fully active the moment a provider is
 *    wired. An optional `opts.injectedSafety` map (tokenAddr->precomputed) lets tests drive
 *    deterministic failures through the SAME code path.
 *
 * @param {object[]} candidates
 * @param {string} baseToken
 * @param {object} [opts] - { provider, router, tokenSafetyCfg, probeAmountInWei, injectedSafety }
 * @returns {Promise<{ safe:object[], dropped:object[], byToken:object[] }>}
 */
async function gateTokenSafety(candidates, baseToken, opts = {}) {
  const safe = [];
  const dropped = [];
  const byToken = [];
  if (!baseToken) {
    // Without a base token we can't orient buy/sell pools; pass through but flag.
    return { safe: candidates.slice(), dropped: [], byToken: [{ note: 'no baseToken — token-safety gate skipped' }] };
  }
  const probeAmount = opts.probeAmountInWei ? BigInt(opts.probeAmountInWei) : (10n ** 18n) / 100n; // 0.01 base default

  for (const cand of candidates) {
    const targets = tokenSafetyTargets(cand, baseToken);
    let candSafe = true;
    const candReasons = [];
    for (const tgt of targets) {
      const injected = opts.injectedSafety ? opts.injectedSafety[tgt.token.toLowerCase()] : undefined;
      const res = await checkToken(
        {
          provider: opts.provider,
          router: opts.router,
          baseToken,
          token: tgt.token,
          amountIn: probeAmount,
          buyPool: tgt.buyPool,
          sellPool: tgt.sellPool,
          precomputed: injected
        },
        opts.tokenSafetyCfg || {}
      );
      byToken.push({ token: tgt.token, safe: res.safe, measuredSellTax: res.measuredSellTax, fidelity: res.fidelity, reasons: res.reasons });
      if (!res.safe) {
        candSafe = false;
        candReasons.push(`${tgt.token}: ${res.reasons.join('; ')}`);
      }
    }
    if (candSafe) {
      safe.push(cand);
    } else {
      dropped.push({ candidate: cand, reasons: candReasons });
    }
  }
  return { safe, dropped, byToken };
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
 * @param {{ windowDays?: number, revertRate?: number, tokenSafetyDropped?: number,
 *          candidatesBeforeSafety?: number }} [obs] - observed run stats.
 * @returns {object} verdict report.
 */
function applyKillCriteria(evals, killCfg, obs = {}) {
  const reasons = [];
  const windowDays = obs.windowDays || 1;
  const tokenSafetyDropped = obs.tokenSafetyDropped || 0;

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

  // Token-safety GATE result (PLAY #4). Dropped candidates never reach evaluation; this is
  // informational in the verdict (the drop already happened). A high drop rate on a fresh-pool
  // run is EXPECTED — long-tail pools are full of honeypots — and proves the gate is working.
  if (tokenSafetyDropped > 0) {
    reasons.push(
      `INFO: token-safety GATE dropped ${tokenSafetyDropped} candidate(s) (honeypot / sell-block ` +
        '/ transfer-tax / max-tx) BEFORE evaluation. Never fired.'
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
      candidatesBeforeSafety: obs.candidatesBeforeSafety ?? evals.length,
      tokenSafetyDropped,
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
 * Full Stage 3+4 run over a snapshot + candidates.
 *
 * PIPELINE ORDER (PLAY #4 gate enforced):
 *   candidates --[token-safety GATE]--> safe candidates --[size+net-of-gas]--> evals --[KILL/GO]
 * Candidates failing token-safety are DROPPED here and never evaluated or fired; the drop
 * count flows into the verdict stats. The gate is async (it may eth_call an RPC); in offline
 * mode it is a no-op pass-through unless `obs.injectedSafety` drives deterministic failures.
 *
 * @param {object} snapshot
 * @param {object[]} candidates - from pathfinder.findCandidateCycles().
 * @param {object} config - full research config (uses .gas, .kill, .sizing, .tokenSafety).
 * @param {{ windowDays?: number, winRate?: number, revertRate?: number,
 *          provider?: object, router?: string, injectedSafety?: object }} [obs]
 * @returns {Promise<{ evals:object[], report:object, executorComparisonSample:object, safety:object }>}
 */
async function runBacktest(snapshot, candidates, config, obs = {}) {
  const gasCfg = config.gas || {};
  const killCfg = config.kill || {};
  const sizingCfg = config.sizing || {};

  // Stage-3 PRE-FIRE token-safety GATE (PLAY #4): drop unsafe candidates before any sizing.
  const safety = await gateTokenSafety(candidates, snapshot.baseToken, {
    provider: obs.provider,
    router: obs.router || (config.tokenSafety && config.tokenSafety.router),
    tokenSafetyCfg: config.tokenSafety || {},
    injectedSafety: obs.injectedSafety
  });
  const safeCandidates = safety.safe;

  const evals = safeCandidates.map((c) => evaluateCandidate(c, gasCfg, sizingCfg));
  const report = applyKillCriteria(evals, killCfg, {
    ...obs,
    tokenSafetyDropped: safety.dropped.length,
    candidatesBeforeSafety: candidates.length
  });
  // Head-to-head fat-vs-lean gas at a representative hop count, for the strip decision.
  const sampleHops = evals.length ? evals[0].hopCount : 3;
  const executorComparisonSample = compareExecutors(sampleHops, gasCfg);
  return { evals, report, executorComparisonSample, safety };
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
  console.log(`candidates (pre-gate): ${report.stats.candidatesBeforeSafety}`);
  console.log(`token-safety dropped : ${report.stats.tokenSafetyDropped}`);
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
  tokenSafetyTargets,
  gateTokenSafety,
  evaluateCandidate,
  applyKillCriteria,
  runBacktest,
  printReport
};
