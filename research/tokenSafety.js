'use strict';

/**
 * Token-safety guard (PLAY #4) — a PER-TOKEN base<->token buy-then-sell probe that flags
 * unsellable / fee-on-transfer / transfer-tax / max-tx-limited / honeypot tokens BEFORE
 * any candidate cycle is allowed to fire.
 *
 * SCOPE / UNIT OF MEASUREMENT (read this first — it was previously overstated):
 * The probe measures ONE token at a time via a 2-hop base<->token round-trip:
 *   base --> token --> base. It is NOT a whole-cycle measurement, and a single 2-hop probe
 * must NEVER be presented as the round-trip tax of a longer (3–5 hop) candidate cycle — that
 * would be apples-to-oranges (the interior token-to-token hops of a cycle are different pools
 * with their own fees/impact). To make a multi-hop candidate safe, the gate runs THIS 2-hop
 * probe INDEPENDENTLY for EACH distinct non-base token on the path and drops the candidate if
 * ANY one token reverts on sell or taxes above threshold. See backtester.gateTokenSafety.
 *
 * WHY THIS IS THE HIGHEST-PRIORITY GUARD (it enables PLAY #3):
 * The long-tail / fresh-pool backrun edge (freshPoolScanner.js) lives in brand-new V2-fork
 * pools whose tokens are overwhelmingly malicious: honeypots that let you BUY but block the
 * SELL, fee-on-transfer tokens that silently skim 10-99% on transfer, tokens with a
 * post-launch `setFee()` flip, and per-tx maximums that make your sized trade revert. A pure
 * CPMM backtest (pathfinder + backtester) is BLIND to all of these — it assumes the V2 pair
 * math is the whole story. Firing into one of these tokens is a 100% capital loss on that leg
 * even though the math said "profit". So every non-base token on a candidate MUST pass this
 * per-token probe first.
 *
 * WHAT THE PER-TOKEN PROBE PROVES (the base<->token round-trip invariant):
 *   buy  baseToken --(base<->token pool)-->  token       (amountToken_received)
 *   sell token     --(base<->token pool)-->  baseToken   (amountBase_back)
 * A clean (taxless, sellable) token returns amountBase_back ≈ amountIn minus only the two
 * V2 swap fees + price impact. We compute the EXPECTED clean base<->token round-trip with the
 * same CPMM math the backtester uses (baseline must be the SAME base<->token pool we quote, or
 * the tax number is meaningless), then compare it to what the chain actually returns when we
 * eth_call the real router with getAmountsOut([base,token]) and getAmountsOut([token,base]).
 * The shortfall, net of the fees we already accounted for, is the MEASURED transfer/sell tax.
 * A revert on the SELL leg (with a non-trivial BUY) is the honeypot signature — and that
 * revert signal needs NO baseline, so it gates EVERY non-base token, interior or not.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * FIDELITY — what is REAL here vs what is TODO'd (be honest):
 *
 *  REAL (implemented):
 *   - The eth_call structure to read getAmountsOut on a real V2 router for the base<->token
 *     2-hop probe (the standard way to ask "what would this swap return", fee-on-transfer-
 *     INCLUSIVE when the router/token apply the tax inside transfer), and a direct
 *     pair.getReserves() cross-check.
 *   - The clean-CPMM expected base<->token round-trip (pure, offline, testable) used as the
 *     baseline — apples-to-apples with the same base<->token venue we quote.
 *   - The decision logic: classify {safe, reasons[], measuredSellTax} from real-vs-expected,
 *     plus a revert => honeypot rule and a max-tx probe (two sizes diverge non-monotonically).
 *
 *  TODO (needs a forked EVM — anvil/foundry/revm — to be exact):
 *   - A TRUE buy-then-sell where we (a) fund a throwaway EOA with baseToken via state
 *     override, (b) actually execute the buy so we hold the token, then (c) actually execute
 *     the sell from that holding. getAmountsOut is an APPROXIMATION: many honeypots gate on
 *     `tx.origin`/holder state/whitelist and look fine to a stateless getAmountsOut but revert
 *     on a real holder's sell. Only a forked execution catches those. We expose simulateOnFork
 *     as the seam and clearly mark it unimplemented when no fork URL is provided.
 *   - Post-launch FEE-FLIP detection beyond a single snapshot needs replaying the token's
 *     setFee/owner calls or watching a holding period; we flag the *capability* (owner can
 *     mutate fees) heuristically and TODO the temporal check.
 *
 * The exported interface is stable regardless of fidelity level:
 *     checkToken(...) -> { safe:boolean, reasons:string[], measuredSellTax:number, ... }
 * so the backtester can gate on it today and the fork upgrade is drop-in later.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

const { ethers } = require('ethers');
const { getAmountOut } = require('./pathfinder.js');

// Standard UniswapV2-style router read methods. getAmountsOut is the canonical "quote"
// call; swapExactTokensForTokensSupportingFeeOnTransferTokens is the fee-on-transfer-aware
// swap whose existence we rely on conceptually (the real execution path lives on a fork).
const ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)'
];

const PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)'
];

// Heuristic ownership/mutable-fee probe ABI (best-effort; absence is non-fatal).
const TOKEN_PROBE_ABI = [
  'function owner() view returns (address)',
  'function getOwner() view returns (address)'
];

// Default policy knobs. All overridable via config.tokenSafety. Documented constants:
const DEFAULTS = Object.freeze({
  // A round-trip whose measured tax exceeds this (fraction, e.g. 0.10 = 10%) is unsafe.
  // Fresh-pool launches legitimately carry a small buy/sell tax (1-5%); >10% net is a
  // value-extraction trap that almost always erases an arb edge.
  maxSellTax: 0.10,
  // Probe size as a fraction of the SELL-pool's token-side reserve. Small enough to keep
  // price impact low (so impact doesn't masquerade as tax) but non-dust so per-tx minimums
  // and rounding-skim taxes actually trigger. 0.1% of reserves.
  probeReserveFraction: 0.001,
  // Second, larger probe (×N) used for the max-tx / non-monotonic-tax detector. If the tax
  // measured at the larger size jumps far beyond what price impact explains, the token has a
  // size-dependent gate (max-tx limit or graduated tax).
  largeProbeMultiplier: 25,
  // Tolerance (fraction) for treating two tax measurements as "the same". Above this gap the
  // tax is size-dependent → suspicious.
  taxConsistencyTolerance: 0.03,
  // If true, an inability to even quote the sell (revert/empty) is treated as a honeypot.
  treatSellQuoteFailureAsHoneypot: true
});

/**
 * Compute the EXPECTED clean (taxless) base<->token round-trip output using the same CPMM math
 * the backtester trusts. This is the baseline we compare the real chain against; the gap is
 * tax. For the comparison to be apples-to-apples, BOTH buyPool and sellPool must describe the
 * SAME base<->token venue the live quote uses (i.e. base->token and token->base over the
 * token's direct base pool) — NOT two different interior hops of a longer cycle.
 *
 * @param {bigint} amountIn - base-token in (wei).
 * @param {{reserveBase:bigint, reserveToken:bigint, feeBps:number}} buyPool  - base->token leg.
 * @param {{reserveToken:bigint, reserveBase:bigint, feeBps:number}} sellPool - token->base leg.
 * @returns {{ tokenMid: bigint, baseBack: bigint }}
 */
function expectedCleanRoundTrip(amountIn, buyPool, sellPool) {
  const tokenMid = getAmountOut(amountIn, buyPool.reserveBase, buyPool.reserveToken, buyPool.feeBps);
  if (tokenMid <= 0n) return { tokenMid: 0n, baseBack: 0n };
  const baseBack = getAmountOut(tokenMid, sellPool.reserveToken, sellPool.reserveBase, sellPool.feeBps);
  return { tokenMid, baseBack };
}

/**
 * Derive the measured sell/transfer tax from a real round-trip vs the clean expectation.
 *
 * Both legs already pay the V2 swap fee (it's inside getAmountOut and inside the real
 * router quote), so the clean baseline ALREADY nets those out. Any *additional* shortfall is
 * the token's own transfer tax / sell-block skim. We clamp to [0,1]: a tiny positive (real >
 * expected) can happen from rounding and is reported as 0 tax.
 *
 * @param {bigint} expectedBaseBack - clean CPMM baseline.
 * @param {bigint} realBaseBack - what the chain actually returns.
 * @returns {number} tax as a fraction in [0,1].
 */
function measuredTaxFromRoundTrip(expectedBaseBack, realBaseBack) {
  if (expectedBaseBack <= 0n) return 1; // can't even compute a baseline → treat as total loss
  if (realBaseBack >= expectedBaseBack) return 0;
  const shortfall = expectedBaseBack - realBaseBack;
  // fraction = shortfall / expected, computed in float on already-small token magnitudes.
  const frac = Number(ethers.formatUnits(shortfall, 18)) / Number(ethers.formatUnits(expectedBaseBack, 18));
  if (!Number.isFinite(frac)) return 1;
  return Math.min(1, Math.max(0, frac));
}

/**
 * eth_call-based real PER-TOKEN base<->token round-trip QUOTE via a V2 router's getAmountsOut.
 *
 * This probes ONE token over the 2-hop path base->token->base (NOT a whole candidate cycle).
 * For a token with fee-on-transfer applied inside its own transfer(), getAmountsOut on a
 * SupportingFeeOnTransfer-aware router does NOT reflect the tax (it uses the library
 * formula). So we do the strongest stateless thing available: quote base->token then
 * token->base and compare to the clean base<->token baseline. The residual catches taxes that
 * the PAIR applies (sync/skim mismatch) and any router that does reflect them; the full
 * holder-state tax requires the fork path (TODO). A SELL-leg revert (with a healthy buy) is
 * the honeypot tell and needs no baseline — it flags the token regardless of its position in
 * any cycle.
 *
 * @param {ethers.Provider} provider
 * @param {object} args
 * @param {string} args.router - V2 router address (must be set; else we fall back to pair math only).
 * @param {string} args.baseToken
 * @param {string} args.token - the long-tail token under test.
 * @param {bigint} args.amountIn
 * @returns {Promise<{ ok:boolean, sellReverted:boolean, realBaseBack:bigint, tokenMid:bigint, error?:string }>}
 */
async function quoteRoundTripViaRouter(provider, args) {
  const { router, baseToken, token, amountIn } = args;
  if (!router) {
    return { ok: false, sellReverted: false, realBaseBack: 0n, tokenMid: 0n, error: 'no router configured' };
  }
  const r = new ethers.Contract(router, ROUTER_ABI, provider);
  let tokenMid = 0n;
  try {
    // BUY leg quote: base -> token.
    const buyAmounts = await r.getAmountsOut(amountIn, [baseToken, token]);
    tokenMid = BigInt(buyAmounts[buyAmounts.length - 1]);
  } catch (err) {
    // A failing BUY quote means the pool/route doesn't exist or the token blocks buys too;
    // either way it's unusable. Not the classic honeypot (which lets you buy), but unsafe.
    return { ok: false, sellReverted: false, realBaseBack: 0n, tokenMid: 0n, error: `buy quote failed: ${err.message}` };
  }
  if (tokenMid <= 0n) {
    return { ok: false, sellReverted: false, realBaseBack: 0n, tokenMid: 0n, error: 'buy quote returned 0' };
  }
  try {
    // SELL leg quote: token -> base. A revert here, with a healthy buy, is the honeypot tell.
    const sellAmounts = await r.getAmountsOut(tokenMid, [token, baseToken]);
    const realBaseBack = BigInt(sellAmounts[sellAmounts.length - 1]);
    return { ok: true, sellReverted: false, realBaseBack, tokenMid };
  } catch (err) {
    return { ok: false, sellReverted: true, realBaseBack: 0n, tokenMid, error: `sell quote reverted: ${err.message}` };
  }
}

/**
 * SEAM for the exact, forked-EVM round-trip. Funds a throwaway EOA with baseToken via state
 * override, executes the real buy, then the real sell, and reads the actual delta. Only this
 * path catches holder-state / tx.origin / whitelist honeypots that a stateless quote misses.
 *
 * STATUS: TODO — not implemented here because it requires a forked-EVM endpoint (anvil
 * `--fork-url`, foundry, or a revm binding) plus eth_call state overrides / impersonation,
 * none of which are available in this skeleton. When `forkUrl` is provided we still return
 * `implemented:false` so callers (and the report) are never misled into trusting a number
 * that wasn't produced. Wiring this is the single biggest fidelity upgrade for PLAY #4.
 *
 * @param {object} _args - { forkUrl, baseToken, token, amountIn, buyRouter, sellRouter }.
 * @returns {Promise<{ implemented:false, reason:string }>}
 */
async function simulateOnFork(_args) {
  return {
    implemented: false,
    reason:
      'TODO(fork): true buy-then-sell needs anvil/foundry/revm fork + state-override funding ' +
      'and execution. Using the eth_call getAmountsOut approximation instead. See module header.'
  };
}

/**
 * Best-effort probe: does the token expose an owner (i.e. someone who *could* flip fees / set
 * a max-tx after launch)? This does not prove malice — most tokens have an owner — but a
 * fresh-pool token with a live owner is a fee-flip RISK we surface as a soft reason, never a
 * hard fail on its own. TODO: replay setFee/transfer-limit setter history for a real verdict.
 *
 * @param {ethers.Provider} provider
 * @param {string} token
 * @returns {Promise<{ hasOwner:boolean, owner:string|null }>}
 */
async function probeOwnership(provider, token) {
  const c = new ethers.Contract(token, TOKEN_PROBE_ABI, provider);
  for (const fn of ['owner', 'getOwner']) {
    try {
      const o = await c[fn]();
      if (o && o !== ethers.ZeroAddress) return { hasOwner: true, owner: ethers.getAddress(o) };
      return { hasOwner: false, owner: ethers.ZeroAddress };
    } catch (_err) {
      // try next
    }
  }
  return { hasOwner: false, owner: null };
}

/**
 * The PUBLIC token-safety check. Stable interface: { safe, reasons[], measuredSellTax, ... }.
 *
 * Pure-input mode (no provider): if `opts.reservesForExpected` and a precomputed
 * `opts.realRoundTrip` are supplied, the function is fully offline and unit-testable — it
 * runs the exact same classification logic the live path uses. This is how the demo and tests
 * exercise the guard with zero RPC.
 *
 * Live mode (provider given): performs the eth_call round-trip quote, the (TODO) fork seam,
 * the max-tx divergence probe, and the ownership probe, then classifies.
 *
 * @param {object} input
 * @param {ethers.Provider} [input.provider] - omit for pure offline classification.
 * @param {string} [input.router] - V2 router for getAmountsOut (live mode).
 * @param {string} input.baseToken
 * @param {string} input.token
 * @param {bigint} input.amountIn - base-token probe amount (wei).
 * @param {object} [input.buyPool]  - { reserveBase, reserveToken, feeBps } clean baseline for the
 *        token's DIRECT base<->token pool (base->token). Omit/null for an interior token with no
 *        direct base pairing: tax is then left unmeasured but the honeypot/sell-revert probe
 *        (which needs no baseline) still runs.
 * @param {object} [input.sellPool] - { reserveToken, reserveBase, feeBps } same base<->token pool
 *        (token->base). Must describe the SAME venue as buyPool, NOT an interior cycle hop.
 * @param {object} [input.precomputed] - offline test injection:
 *        { realBaseBack:bigint, sellReverted?:boolean, largeRealBaseBack?:bigint, hasOwner?:boolean }.
 * @param {object} [cfg] - config.tokenSafety overrides (see DEFAULTS).
 * @returns {Promise<{
 *   safe:boolean, reasons:string[], measuredSellTax:number,
 *   honeypot:boolean, maxTxSuspected:boolean, feeFlipRisk:boolean,
 *   fidelity:'fork'|'eth_call'|'offline', expectedBaseBackWei:string, realBaseBackWei:string
 * }>}
 */
async function checkToken(input, cfg = {}) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  const reasons = [];
  let honeypot = false;
  let maxTxSuspected = false;
  let feeFlipRisk = false;

  const amountIn = BigInt(input.amountIn);

  // 1) Clean CPMM baseline (always computable if reserves are provided).
  let expected = { tokenMid: 0n, baseBack: 0n };
  const haveBaseline = input.buyPool && input.sellPool;
  if (haveBaseline) {
    expected = expectedCleanRoundTrip(
      amountIn,
      { reserveBase: BigInt(input.buyPool.reserveBase), reserveToken: BigInt(input.buyPool.reserveToken), feeBps: input.buyPool.feeBps },
      { reserveToken: BigInt(input.sellPool.reserveToken), reserveBase: BigInt(input.sellPool.reserveBase), feeBps: input.sellPool.feeBps }
    );
  }

  // 2) Obtain the REAL round-trip result. Priority: fork (TODO) > eth_call quote > injected.
  let fidelity = 'offline';
  let realBaseBack = 0n;
  let sellReverted = false;

  if (input.precomputed && typeof input.precomputed.realBaseBack !== 'undefined') {
    // Offline/test injection — exercise the SAME classifier deterministically.
    realBaseBack = BigInt(input.precomputed.realBaseBack);
    sellReverted = !!input.precomputed.sellReverted;
    fidelity = 'offline';
  } else if (input.provider) {
    // (Attempt the exact fork path first; it self-reports unimplemented today.)
    const fork = await simulateOnFork({
      forkUrl: input.forkUrl,
      baseToken: input.baseToken,
      token: input.token,
      amountIn
    });
    if (fork.implemented) {
      fidelity = 'fork';
      realBaseBack = BigInt(fork.realBaseBack);
      sellReverted = !!fork.sellReverted;
    } else {
      // eth_call approximation.
      const q = await quoteRoundTripViaRouter(input.provider, {
        router: input.router,
        baseToken: input.baseToken,
        token: input.token,
        amountIn
      });
      fidelity = 'eth_call';
      if (!q.ok) {
        sellReverted = q.sellReverted;
        if (q.sellReverted) {
          honeypot = true;
          reasons.push(`HONEYPOT: BUY quoted fine but SELL leg reverted (${q.error}).`);
        } else {
          reasons.push(`UNQUOTABLE: round-trip quote failed (${q.error}). Treating as unsafe.`);
        }
      } else {
        realBaseBack = q.realBaseBack;
      }
    }
  } else {
    // No provider and no injection: we can only return the offline baseline as advisory.
    reasons.push('NO-DATA: no provider and no precomputed round-trip — offline baseline only.');
  }

  // 3) Honeypot rule for the explicit injection path too.
  if (sellReverted && !honeypot) {
    honeypot = true;
    reasons.push('HONEYPOT: SELL leg reverted on a non-trivial buy.');
  }

  // 4) Measure the tax from real-vs-expected (only meaningful with a baseline and a real sell).
  let measuredSellTax = 0;
  if (honeypot) {
    measuredSellTax = 1; // unsellable == 100% loss on the token leg
  } else if (haveBaseline && realBaseBack > 0n) {
    measuredSellTax = measuredTaxFromRoundTrip(expected.baseBack, realBaseBack);
    if (measuredSellTax > c.maxSellTax) {
      reasons.push(
        `SELL-TAX: measured base<->token round-trip tax ${(measuredSellTax * 100).toFixed(2)}% > ` +
          `${(c.maxSellTax * 100).toFixed(2)}% limit (fee-on-transfer / transfer-tax).`
      );
    }
  } else if (!honeypot && !haveBaseline) {
    reasons.push('TAX-UNMEASURED: no CPMM baseline (reserves) supplied — tax not quantified.');
  }

  // 5) Max-tx / size-dependent-tax probe: re-probe the SAME base<->token round-trip at a larger
  // size. Two independent signals:
  //   (a) SELL-REVERT-AT-SIZE — fine small, reverts large → max-tx / anti-whale gate. This needs
  //       NO baseline, so it runs for ANY non-base token in live eth_call mode (interior tokens
  //       on a longer cycle included).
  //   (b) GRADUATED TAX — the measured tax JUMPS beyond what price impact explains. This is a
  //       relative comparison against the clean baseline, so it requires haveBaseline.
  // Offline tests drive (b) via precomputed.largeRealBaseBack.
  if (!honeypot && (haveBaseline || (input.provider && fidelity === 'eth_call'))) {
    let largeReal = null;
    const largeIn = amountIn * BigInt(c.largeProbeMultiplier);
    const largeExpected = haveBaseline
      ? expectedCleanRoundTrip(
          largeIn,
          { reserveBase: BigInt(input.buyPool.reserveBase), reserveToken: BigInt(input.buyPool.reserveToken), feeBps: input.buyPool.feeBps },
          { reserveToken: BigInt(input.sellPool.reserveToken), reserveBase: BigInt(input.sellPool.reserveBase), feeBps: input.sellPool.feeBps }
        )
      : { tokenMid: 0n, baseBack: 0n };
    if (input.precomputed && typeof input.precomputed.largeRealBaseBack !== 'undefined') {
      largeReal = BigInt(input.precomputed.largeRealBaseBack);
    } else if (input.provider && fidelity === 'eth_call') {
      const q2 = await quoteRoundTripViaRouter(input.provider, {
        router: input.router,
        baseToken: input.baseToken,
        token: input.token,
        amountIn: largeIn
      });
      if (q2.sellReverted) {
        // (a) Sells fine small but reverts large → classic max-tx / anti-whale honeypot variant.
        // Baseline-independent, so this guards interior tokens of longer cycles too.
        maxTxSuspected = true;
        reasons.push('MAX-TX: SELL reverts at a larger size but not a small one (per-tx limit / anti-whale).');
      } else if (q2.ok) {
        largeReal = q2.realBaseBack;
      }
    }
    // (b) Graduated-tax comparison only when we have an apples-to-apples baseline.
    if (haveBaseline && largeReal !== null && largeExpected.baseBack > 0n) {
      const largeTax = measuredTaxFromRoundTrip(largeExpected.baseBack, largeReal);
      if (largeTax - measuredSellTax > c.taxConsistencyTolerance) {
        maxTxSuspected = true;
        reasons.push(
          `MAX-TX/GRADUATED-TAX: tax rises from ${(measuredSellTax * 100).toFixed(2)}% (small) to ` +
            `${(largeTax * 100).toFixed(2)}% (×${c.largeProbeMultiplier} size) beyond price impact.`
        );
      }
    }
  }

  // 6) Fee-flip RISK (soft): a live owner can mutate fees/limits after launch. Heuristic only.
  let hasOwner = false;
  if (input.precomputed && typeof input.precomputed.hasOwner !== 'undefined') {
    hasOwner = !!input.precomputed.hasOwner;
  } else if (input.provider) {
    const own = await probeOwnership(input.provider, input.token);
    hasOwner = own.hasOwner;
  }
  if (hasOwner) {
    feeFlipRisk = true;
    reasons.push(
      'FEE-FLIP-RISK(soft): token has a live owner that COULD set fees / max-tx post-launch. ' +
        'TODO(temporal): replay setter history to confirm. Not a hard fail by itself.'
    );
  }

  // 7) Final verdict. Hard fails: honeypot, sell-tax over limit, max-tx, or unquotable.
  const hardFail =
    honeypot ||
    maxTxSuspected ||
    measuredSellTax > c.maxSellTax ||
    reasons.some((r) => r.startsWith('UNQUOTABLE')) ||
    reasons.some((r) => r.startsWith('HONEYPOT'));

  return {
    safe: !hardFail,
    reasons,
    measuredSellTax,
    honeypot,
    maxTxSuspected,
    feeFlipRisk,
    fidelity,
    expectedBaseBackWei: expected.baseBack.toString(),
    realBaseBackWei: realBaseBack.toString()
  };
}

module.exports = {
  DEFAULTS,
  ROUTER_ABI,
  PAIR_ABI,
  expectedCleanRoundTrip,
  measuredTaxFromRoundTrip,
  quoteRoundTripViaRouter,
  simulateOnFork,
  probeOwnership,
  checkToken
};
