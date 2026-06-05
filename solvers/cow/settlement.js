'use strict';

/**
 * CoW <-> BofhContractV2 settlement bridge.
 *
 * RESPONSIBILITY: turn a routed arbitrage/fill (a baseToken-anchored V2-fork path resolved
 * by the pathfinder) into the exact CoW "custom interaction" tuple that the GPv2Settlement
 * contract will execute, by encoding a call to BofhContractV2.executeSwapMultiDex(...).
 *
 * HOW THE PIECES FIT (non-custodial, single tx):
 *   GPv2Settlement (holds the order's sell tokens after the trade transfer-in)
 *     --[ custom interaction: approve sellToken to BofhContractV2 ]-->
 *     --[ custom interaction: executeSwapMultiDex(...) ]-->
 *        BofhContractV2 pulls sellToken from Settlement (msg.sender == Settlement),
 *        routes across the V2-fork DexRegistry, returns buyToken to Settlement in-tx.
 *   Settlement then pays out the order using its now-increased buyToken balance.
 *
 * The CoW solver `interactions` array (CustomInteraction variant, per the solver openapi.yml)
 * has the shape:
 *   {
 *     kind: "custom",
 *     target: address,            // contract the Settlement will .call()
 *     value: TokenAmount,         // native value (decimal string, wei) — "0" here
 *     callData: hex,              // ABI-encoded calldata
 *     inputs:  [ { token, amount } ],  // assets this interaction CONSUMES from Settlement
 *     outputs: [ { token, amount } ],  // assets this interaction PRODUCES to Settlement
 *     allowances: [ { token, spender, amount } ]  // optional ERC20 approvals to set first
 *   }
 *
 * NOTE on truthfulness: BofhContractV2.executeSwapMultiDex requires `path[0] == baseToken`
 * and `path[last] == baseToken` (round-trip arb), and it pulls `amountIn` of baseToken from
 * msg.sender. For a CoW FILL where sellToken != baseToken, the contract as-is is NOT a drop-in
 * router — see the README "V2-only liquidity limit" + "interaction-contract shape" gates. This
 * encoder targets the case the contract actually supports today: a baseToken-in / baseToken-out
 * route, i.e. an arbitrage backrun surfaced inside the batch, OR an order whose sell AND buy
 * token is the baseToken leg. Generalising to arbitrary sell/buy tokens is a contract change
 * (TODO), flagged loudly rather than silently mis-encoded.
 */

const { ethers } = require('ethers');

// Minimal ABI fragments — we only need the entrypoint and ERC20 approve for encoding.
const BOFH_ABI = [
  'function executeSwapMultiDex(address[] path, uint256[] fees, uint16[] dexIds, uint256 amountIn, uint256 minAmountOut, uint256 deadline) external returns (uint256)'
];
const ERC20_ABI = ['function approve(address spender, uint256 amount) external returns (bool)'];

const bofhIface = new ethers.Interface(BOFH_ABI);
const erc20Iface = new ethers.Interface(ERC20_ABI);

// Sentinel BofhContractV2 understands for "use the registered registry feeBps for this hop".
const REGISTRY_FEE_SENTINEL = (2n ** 256n - 1n).toString(); // type(uint256).max

/**
 * Build the executeSwapMultiDex calldata for a resolved route.
 *
 * @param {object} route - a routed cycle/path. Expected shape (mirrors pathfinder hops):
 *   {
 *     tokens:   string[],          // path addresses, length = hops+1, [0]==[last]==baseToken
 *     hops:     Array<{ dexId?: number, feeBps?: number }>,  // length = tokens.length - 1
 *     amountInWei:  string|bigint, // baseToken in
 *     minAmountOutWei: string|bigint // economic backstop (the contract's real guard)
 *   }
 * @param {object} opts
 * @param {number} opts.deadline - unix seconds; contract reverts if block.timestamp > deadline.
 * @param {boolean} [opts.useRegistryFees=true] - emit the fee sentinel so on-chain registry
 *   feeBps is authoritative (recommended; avoids off-chain/on-chain fee drift reverts).
 * @returns {{ callData: string, path: string[], fees: string[], dexIds: number[], amountIn: string, minAmountOut: string }}
 */
function encodeExecuteSwapMultiDex(route, opts) {
  if (!route || !Array.isArray(route.tokens) || route.tokens.length < 3) {
    throw new Error('encodeExecuteSwapMultiDex: route.tokens must be a path of length >= 3 (start==end==baseToken).');
  }
  const path = route.tokens;
  const hops = route.hops || [];
  if (hops.length !== path.length - 1) {
    throw new Error(`encodeExecuteSwapMultiDex: hops (${hops.length}) must equal path.length-1 (${path.length - 1}).`);
  }
  if (path[0].toLowerCase() !== path[path.length - 1].toLowerCase()) {
    // Contract enforces this; fail here with a clear message rather than letting it revert on-chain.
    throw new Error('encodeExecuteSwapMultiDex: path must start and end at the SAME baseToken (round-trip).');
  }

  const useRegistryFees = opts.useRegistryFees !== false;
  const fees = hops.map((h) =>
    useRegistryFees || h.feeBps == null ? REGISTRY_FEE_SENTINEL : BigInt(Math.round(h.feeBps)).toString()
  );
  const dexIds = hops.map((h) => Number(h.dexId ?? 0)); // dexId 0 = immutable factory fallback

  const amountIn = BigInt(route.amountInWei).toString();
  const minAmountOut = BigInt(route.minAmountOutWei).toString();
  const deadline = BigInt(opts.deadline).toString();

  const callData = bofhIface.encodeFunctionData('executeSwapMultiDex', [
    path,
    fees,
    dexIds,
    amountIn,
    minAmountOut,
    deadline
  ]);

  return { callData, path, fees, dexIds, amountIn, minAmountOut };
}

/**
 * Build the ERC20 `approve(spender, amount)` calldata Settlement must run so BofhContractV2
 * can transferFrom the sell/base token. We approve the exact amountIn (not unlimited) to keep
 * the interaction minimal-trust within the batch.
 * @param {string} spender - BofhContractV2 address.
 * @param {string|bigint} amount
 * @returns {string} calldata
 */
function encodeApprove(spender, amount) {
  return erc20Iface.encodeFunctionData('approve', [spender, BigInt(amount).toString()]);
}

/**
 * Produce the CoW custom-interaction TUPLE(s) for a route: an optional approve interaction
 * followed by the executeSwapMultiDex interaction. Returns them in execution order.
 *
 * @param {object} route - see encodeExecuteSwapMultiDex.
 * @param {object} ctx
 * @param {string} ctx.interactionContract - BofhContractV2 address (the `target`).
 * @param {number} ctx.deadline - unix seconds.
 * @param {boolean} [ctx.includeApprove=true] - prepend an ERC20 approve interaction.
 * @param {boolean} [ctx.useRegistryFees=true]
 * @returns {Array<object>} CoW `interactions` entries (kind:"custom"), in order.
 */
function buildBofhInteractions(route, ctx) {
  if (!ctx || !ctx.interactionContract || /^0x0{40}$/i.test(ctx.interactionContract)) {
    throw new Error('buildBofhInteractions: ctx.interactionContract is unset/zero — deploy BofhContractV2 and set its address in config (TODO).');
  }
  const enc = encodeExecuteSwapMultiDex(route, {
    deadline: ctx.deadline,
    useRegistryFees: ctx.useRegistryFees
  });

  const baseToken = enc.path[0];
  const interactions = [];

  if (ctx.includeApprove !== false) {
    interactions.push({
      kind: 'custom',
      target: baseToken, // the ERC20 we approve from Settlement's balance
      value: '0',
      callData: encodeApprove(ctx.interactionContract, enc.amountIn),
      // approve consumes/produces no token *balances* from the Settlement's accounting view.
      inputs: [],
      outputs: [],
      // allowances is the CoW-native way to express the same approval; we set BOTH the explicit
      // approve call (works on every ERC20) and the structured allowance (driver may optimise).
      allowances: [
        { token: baseToken, spender: ctx.interactionContract, amount: enc.amountIn }
      ]
    });
  }

  interactions.push({
    kind: 'custom',
    target: ctx.interactionContract,
    value: '0',
    callData: enc.callData,
    // The swap consumes amountIn of baseToken from Settlement and returns >= minAmountOut.
    // CoW uses inputs/outputs to verify the interaction's net token movement against the batch.
    inputs: [{ token: baseToken, amount: enc.amountIn }],
    outputs: [{ token: baseToken, amount: enc.minAmountOut }],
    allowances: []
  });

  return interactions;
}

module.exports = {
  REGISTRY_FEE_SENTINEL,
  encodeExecuteSwapMultiDex,
  encodeApprove,
  buildBofhInteractions
};
