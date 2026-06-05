'use strict';

/**
 * Stage 1 — Multi-fork V2 pool scanner (ethers v6).
 *
 * GOAL: produce a "pool snapshot" — a static, offline-replayable JSON file describing
 * every V2-fork pool of interest on a target chain at a given block, with reserves, the
 * token ordering, and the PER-FORK swap fee. The pathfinder and backtester consume this
 * snapshot as a pure input, so the entire research pipeline is reproducible offline.
 *
 * This REPLACES scripts/find-arbitrage.js, which is a Hardhat mock-pool demo (it deploys
 * MockPair/MockFactory and fabricates reserves). Here the getReserves/token0/token1 calls
 * are REAL ethers v6 contract calls against a real RPC.
 *
 * STATUS: runnable skeleton.
 *  - REAL: getReserves(), token0(), token1() against live pairs via ethers v6.
 *  - TODO: full pair ENUMERATION (replay PairCreated logs OR allPairsLength+allPairs(i)),
 *    Multicall3 batching of getReserves, persistence to a real registry (Postgres/Parquet),
 *    and per-fork fee VERIFICATION on-chain instead of trusting config.
 *
 * Snapshot schema (v1):
 * {
 *   "version": 1,
 *   "chainKey": "bsc",
 *   "chainId": 56,
 *   "blockNumber": 1234567,
 *   "baseToken": "0x...",
 *   "takenAtIso": "2026-06-05T00:00:00.000Z",
 *   "tokens": { "0xabc...": { "symbol": "?", "decimals": 18 }, ... },
 *   "pools": [
 *     { "pair":"0x..","factory":"0x..","dex":"PancakeSwapV2","token0":"0x..","token1":"0x..",
 *       "reserve0":"123","reserve1":"456","feeBps":25 }, ...
 *   ]
 * }
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const { loadConfig, enabledChains } = require('./config.js');

// Minimal ABIs — only the read methods we need.
const PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)'
];

const FACTORY_ABI = [
  'function allPairsLength() view returns (uint256)',
  'function allPairs(uint256) view returns (address)',
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)'
];

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
];

const SNAPSHOT_VERSION = 1;

/**
 * Build an ethers v6 JsonRpcProvider for a chain, or null if no RPC env var is set.
 * @param {object} chain - element from enabledChains().
 * @returns {ethers.JsonRpcProvider|null}
 */
function makeProvider(chain) {
  if (!chain.rpcUrl) {
    console.warn(
      `[scanner] no RPC for chain "${chain.key}" — set env ${chain.cfg.rpcEnv} (or fallback). Skipping.`
    );
    return null;
  }
  // staticNetwork avoids an extra eth_chainId round-trip per call.
  return new ethers.JsonRpcProvider(chain.rpcUrl, chain.cfg.chainId, {
    staticNetwork: true
  });
}

/**
 * REAL read of a single pair's on-chain state. This is the load-bearing live call.
 * @param {ethers.Provider} provider
 * @param {string} pairAddress
 * @param {number|string} feeBps - per-fork fee, basis points (e.g. 25 = 0.25%).
 * @param {object} [meta] - { factory, dex } provenance to embed in the pool record.
 * @returns {Promise<object>} pool record for the snapshot.
 */
async function readPair(provider, pairAddress, feeBps, meta = {}) {
  const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
  // ethers v6 returns bigints; getReserves returns a Result tuple.
  const [reserves, token0, token1] = await Promise.all([
    pair.getReserves(),
    pair.token0(),
    pair.token1()
  ]);
  return {
    pair: ethers.getAddress(pairAddress),
    factory: meta.factory ? ethers.getAddress(meta.factory) : null,
    dex: meta.dex || null,
    token0: ethers.getAddress(token0),
    token1: ethers.getAddress(token1),
    reserve0: reserves[0].toString(),
    reserve1: reserves[1].toString(),
    feeBps: Number(feeBps)
  };
}

/**
 * Enumerate the pairs of a single factory.
 *
 * TODO(real-enumeration): the production path is one of:
 *   (a) replay PairCreated logs in block ranges via provider.getLogs({ address: factory,
 *       topics: [PairCreated] }) and decode with the factory interface; OR
 *   (b) read allPairsLength() then allPairs(i) for i in [0, len), batched via Multicall3.
 * Both are O(#pairs) and must be paginated. For thin/long-tail chains the PairCreated
 * replay is preferred because it also gives you creation block (freshness signal).
 *
 * This skeleton only returns an EXPLICIT seed list if provided in config
 * (chainCfg.factories[dex].seedPairs), so the rest of the pipeline is runnable without
 * a full enumeration. Returns [] otherwise (with a TODO warning).
 *
 * @param {ethers.Provider} provider
 * @param {string} dex
 * @param {{ address: string, feeBps: number, seedPairs?: string[] }} factoryCfg
 * @param {{ maxPairsPerFactory: number }} scanCfg
 * @returns {Promise<Array<{ pair:string, factory:string, dex:string, feeBps:number }>>}
 */
async function enumeratePairs(provider, dex, factoryCfg, scanCfg) {
  const factoryAddr = factoryCfg.address;

  // Skeleton fast-path: explicit seed pairs let the whole toolkit run end-to-end now.
  if (Array.isArray(factoryCfg.seedPairs) && factoryCfg.seedPairs.length > 0) {
    return factoryCfg.seedPairs.map((p) => ({
      pair: p,
      factory: factoryAddr,
      dex,
      feeBps: Number(factoryCfg.feeBps)
    }));
  }

  // Sanity-probe the factory so the skeleton at least proves connectivity + ABI.
  try {
    const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
    const len = await factory.allPairsLength();
    console.warn(
      `[scanner] ${dex} (${factoryAddr}) has ${len.toString()} pairs. ` +
        'TODO: implement real enumeration (PairCreated replay or allPairs(i) + Multicall3). ' +
        'Returning [] for now — add "seedPairs" in config to test downstream stages.'
    );
  } catch (err) {
    console.warn(`[scanner] could not probe factory ${dex} (${factoryAddr}): ${err.message}`);
  }
  return [];
}

/**
 * Best-effort token metadata (symbol/decimals). Failures are non-fatal — many long-tail
 * tokens have non-standard or missing metadata; we keep decimals=18 as a placeholder and
 * flag it. TODO: batch via Multicall3 and cache to the registry.
 * @param {ethers.Provider} provider
 * @param {Set<string>} tokenAddrs
 * @returns {Promise<Record<string,{symbol:string,decimals:number,probed:boolean}>>}
 */
async function readTokenMeta(provider, tokenAddrs) {
  const out = {};
  for (const addr of tokenAddrs) {
    try {
      const erc = new ethers.Contract(addr, ERC20_ABI, provider);
      const [symbol, decimals] = await Promise.all([erc.symbol(), erc.decimals()]);
      out[addr] = { symbol, decimals: Number(decimals), probed: true };
    } catch (_err) {
      out[addr] = { symbol: '?', decimals: 18, probed: false };
    }
  }
  return out;
}

/**
 * Scan a single chain into a snapshot object (does not write to disk).
 * @param {object} chain - element from enabledChains().
 * @param {object} config - full research config.
 * @returns {Promise<object|null>} snapshot, or null if the chain was skipped.
 */
async function scanChain(chain, config) {
  const provider = makeProvider(chain);
  if (!provider) return null;

  const scanCfg = config.scan || {};
  const blockNumber = await provider.getBlockNumber();

  const pools = [];
  const factories = chain.cfg.factories || {};
  for (const [dex, factoryCfg] of Object.entries(factories)) {
    if (dex.startsWith('_')) continue;
    const candidates = await enumeratePairs(provider, dex, factoryCfg, scanCfg);
    for (const c of candidates) {
      try {
        const rec = await readPair(provider, c.pair, c.feeBps, { factory: c.factory, dex: c.dex });
        pools.push(rec);
      } catch (err) {
        console.warn(`[scanner] failed reading pair ${c.pair} on ${dex}: ${err.message}`);
      }
    }
  }

  const tokenAddrs = new Set();
  for (const p of pools) {
    tokenAddrs.add(p.token0);
    tokenAddrs.add(p.token1);
  }
  const tokens = await readTokenMeta(provider, tokenAddrs);

  return {
    version: SNAPSHOT_VERSION,
    chainKey: chain.key,
    chainId: chain.cfg.chainId,
    blockNumber,
    baseToken: chain.baseToken.address, // may be null if addresses.js lacks the chain (TODO)
    baseTokenSymbol: chain.baseToken.symbol,
    takenAtIso: new Date().toISOString(),
    tokens,
    pools
  };
}

/**
 * Write a snapshot to disk (creates parent dirs). Returns the path written.
 * @param {object} snapshot
 * @param {string} outPath
 * @returns {string}
 */
function writeSnapshot(snapshot, outPath) {
  const abs = path.isAbsolute(outPath) ? outPath : path.join(process.cwd(), outPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(snapshot, null, 2));
  return abs;
}

/**
 * CLI entrypoint: scan all enabled chains and write one snapshot per chain.
 */
async function main() {
  const { config, sourcePath } = loadConfig();
  console.log(`[scanner] config: ${sourcePath}`);
  const chains = enabledChains(config);
  if (chains.length === 0) {
    console.warn('[scanner] no enabled chains. Enable one in research/config.json.');
    return;
  }

  for (const chain of chains) {
    console.log(`[scanner] scanning ${chain.key} (chainId ${chain.cfg.chainId})...`);
    const snapshot = await scanChain(chain, config);
    if (!snapshot) continue;

    const base = (config.scan && config.scan.snapshotOutPath) || 'research/data/snapshot.json';
    // Canonical per-chain filename: snapshot.<chain>.json. Inject `.<chain>` right before
    // the final extension so the result is deterministic regardless of the configured base
    // (e.g. ".../snapshot.json" -> ".../snapshot.bsc.json"). Documented in research/README.md.
    const ext = path.extname(base);
    const outPath = `${base.slice(0, base.length - ext.length)}.${chain.key}${ext}`;
    const written = writeSnapshot(snapshot, outPath);
    console.log(
      `[scanner] ${chain.key}: ${snapshot.pools.length} pools @ block ${snapshot.blockNumber} -> ${written}`
    );
  }
}

module.exports = {
  SNAPSHOT_VERSION,
  PAIR_ABI,
  FACTORY_ABI,
  makeProvider,
  readPair,
  enumeratePairs,
  readTokenMeta,
  scanChain,
  writeSnapshot
};

if (require.main === module) {
  main().catch((err) => {
    console.error('[scanner] fatal:', err);
    process.exitCode = 1;
  });
}
