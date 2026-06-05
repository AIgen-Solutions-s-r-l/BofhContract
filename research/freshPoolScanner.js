'use strict';

/**
 * Stage 1b — FRESH-POOL scanner (PLAY #3): enumerate NEWLY-created V2-fork pairs by replaying
 * `PairCreated` logs over a recent block window, keep only pools younger than an age budget,
 * read their reserves, and emit the SAME snapshot shape scanner.js produces so pathfinder.js
 * and backtester.js consume it unchanged.
 *
 * WHY (the long-tail / fresh-pool backrun edge):
 * On a Priority-Gas-Auction chain (Monad / HyperEVM) the durable edge is NOT competing for
 * the same fat blue-chip pools every searcher already watches — it's being first into a
 * brand-new pool the moment liquidity lands, before the spread is arbitraged away. The
 * freshness signal that makes this tractable is exactly the PairCreated log: it gives the
 * creation block (hence the AGE) for free. We replay those logs, filter by age, snapshot
 * reserves, and hand the result to the existing pipeline. Token safety (tokenSafety.js) then
 * gates which of these fresh tokens we're actually willing to fire into — fresh pools are
 * where honeypots live.
 *
 * SNAPSHOT SHAPE: identical to scanner.js (SNAPSHOT_VERSION pools[] with
 * pair/factory/dex/token0/token1/reserve0/reserve1/feeBps) PLUS two extra per-pool fields the
 * downstream stages ignore but the fresh-pool play uses:
 *   - createdBlock: block the PairCreated log was emitted (freshness anchor).
 *   - ageBlocks:    blockNumber(snapshot) - createdBlock (how fresh, in blocks).
 *   - competitorCount: number of OTHER fresh pairs created in the same block on the same
 *     factory (a crude contention proxy — many simultaneous launches => more bots watching).
 * These are additive and optional, so a snapshot from freshPoolScanner is a strict superset of
 * a scanner.js snapshot and drops into pathfinder/backtester with no changes.
 *
 * FIDELITY:
 *  REAL: getLogs(PairCreated) over a block window + topic decode (ethers v6 Interface), age
 *        filter, getReserves()/token0()/token1() reads, snapshot assembly. These are the real
 *        live calls; with an RPC env var set this scanner runs against a real chain today.
 *  TODO: getLogs RANGE CHUNKING for providers that cap block-span/result-count (we expose
 *        `maxBlockSpan` and chunk, but very large backfills need cursoring + retry/backoff);
 *        Multicall3 batching of the reserve reads; persistence to a real registry. Same TODO
 *        surface as scanner.js — intentionally consistent.
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const { loadConfig, enabledChains } = require('./config.js');
const { SNAPSHOT_VERSION, makeProvider, readPair, readTokenMeta } = require('./scanner.js');

// PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsIdx)
// This is the CANONICAL UniswapV2 factory event signature; PancakeSwap V2, SushiSwap V2 and the
// vast majority of V2 forks emit the byte-identical event (same topic0), so this decode works
// across them unchanged.
// TODO(non-canonical forks): some forks rename/re-order args or add fields (e.g. a fee tier),
// changing topic0 — those need a per-factory event signature/ABI override before getLogs.
const PAIR_CREATED_ABI = [
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)'
];
const PAIR_CREATED_IFACE = new ethers.Interface(PAIR_CREATED_ABI);
const PAIR_CREATED_TOPIC = ethers.id('PairCreated(address,address,address,uint256)');

// Default fresh-pool knobs (overridable via config.freshScan). Documented constants:
const DEFAULTS = Object.freeze({
  // How many blocks back from `latest` to replay PairCreated for. A "fresh window".
  lookbackBlocks: 5000,
  // Maximum pool age (in blocks) to KEEP. Pools older than this are not "fresh" anymore and
  // their launch spread is presumed already arbitraged. Must be <= lookbackBlocks to matter.
  maxAgeBlocks: 1500,
  // getLogs is chunked into spans of at most this many blocks (provider result/range caps).
  maxBlockSpan: 2000,
  // Cap on pools kept per factory, newest first, to bound downstream work.
  maxFreshPerFactory: 500
});

/**
 * Replay PairCreated logs for ONE factory over [fromBlock, toBlock], chunked by maxBlockSpan.
 * Returns one record per created pair with its creation block.
 *
 * @param {ethers.Provider} provider
 * @param {string} dex
 * @param {{ address:string, feeBps:number }} factoryCfg
 * @param {{ fromBlock:number, toBlock:number, maxBlockSpan:number }} window
 * @returns {Promise<Array<{ pair:string, factory:string, dex:string, feeBps:number,
 *           token0:string, token1:string, createdBlock:number }>>}
 */
async function replayPairCreated(provider, dex, factoryCfg, window) {
  const factoryAddr = ethers.getAddress(factoryCfg.address);
  const span = Math.max(1, Number(window.maxBlockSpan || DEFAULTS.maxBlockSpan));
  const out = [];

  for (let from = window.fromBlock; from <= window.toBlock; from += span) {
    const to = Math.min(from + span - 1, window.toBlock);
    let logs;
    try {
      logs = await provider.getLogs({
        address: factoryAddr,
        topics: [PAIR_CREATED_TOPIC],
        fromBlock: from,
        toBlock: to
      });
    } catch (err) {
      // TODO(chunking): on "range too wide / too many results" providers, subdivide and retry
      // with backoff. We warn and skip the chunk so a single bad span doesn't kill the scan.
      console.warn(
        `[freshScan] ${dex} getLogs ${from}-${to} failed: ${err.message}. ` +
          'TODO: subdivide+retry. Skipping this span.'
      );
      continue;
    }
    for (const log of logs) {
      let parsed;
      try {
        parsed = PAIR_CREATED_IFACE.parseLog({ topics: log.topics, data: log.data });
      } catch (_err) {
        continue; // not a PairCreated we can decode
      }
      out.push({
        pair: ethers.getAddress(parsed.args.pair),
        factory: factoryAddr,
        dex,
        feeBps: Number(factoryCfg.feeBps),
        token0: ethers.getAddress(parsed.args.token0),
        token1: ethers.getAddress(parsed.args.token1),
        createdBlock: Number(log.blockNumber)
      });
    }
  }
  return out;
}

/**
 * Annotate a list of created-pair records with competitorCount = how many OTHER pairs were
 * created in the SAME block on the SAME factory (a crude same-block-launch contention proxy).
 * Pure helper (no I/O) so it's testable.
 *
 * @param {Array<{createdBlock:number, pair:string}>} created
 * @returns {Map<string, number>} pair -> competitorCount
 */
function computeCompetitorCounts(created) {
  const perBlock = new Map();
  for (const c of created) {
    perBlock.set(c.createdBlock, (perBlock.get(c.createdBlock) || 0) + 1);
  }
  const out = new Map();
  for (const c of created) {
    // "competitors" = others in the same block => total in block minus self.
    out.set(c.pair, (perBlock.get(c.createdBlock) || 1) - 1);
  }
  return out;
}

/**
 * Filter created pairs to those younger than maxAgeBlocks at `headBlock`, newest first,
 * capped at maxFreshPerFactory. Pure helper (testable).
 *
 * @param {Array<{createdBlock:number}>} created
 * @param {number} headBlock
 * @param {{ maxAgeBlocks:number, maxFreshPerFactory:number }} cfg
 * @returns {Array<object>} filtered + age-annotated records (adds ageBlocks).
 */
function filterFresh(created, headBlock, cfg) {
  const maxAge = Number(cfg.maxAgeBlocks ?? DEFAULTS.maxAgeBlocks);
  const cap = Number(cfg.maxFreshPerFactory ?? DEFAULTS.maxFreshPerFactory);
  const withAge = created
    .map((c) => ({ ...c, ageBlocks: headBlock - c.createdBlock }))
    .filter((c) => c.ageBlocks >= 0 && c.ageBlocks <= maxAge)
    .sort((a, b) => b.createdBlock - a.createdBlock); // newest first
  return withAge.slice(0, cap);
}

/**
 * Scan ONE chain for fresh pools and assemble a (superset) snapshot. Does not write to disk.
 * @param {object} chain - element from enabledChains().
 * @param {object} config - full research config (uses .freshScan).
 * @returns {Promise<object|null>} snapshot or null if skipped.
 */
async function scanFreshChain(chain, config) {
  const provider = makeProvider(chain);
  if (!provider) return null;

  const cfg = { ...DEFAULTS, ...(config.freshScan || {}) };
  const head = await provider.getBlockNumber();
  const fromBlock = Math.max(0, head - Number(cfg.lookbackBlocks || DEFAULTS.lookbackBlocks));

  const pools = [];
  const factories = chain.cfg.factories || {};
  for (const [dex, factoryCfg] of Object.entries(factories)) {
    if (dex.startsWith('_')) continue;
    const created = await replayPairCreated(provider, dex, factoryCfg, {
      fromBlock,
      toBlock: head,
      maxBlockSpan: cfg.maxBlockSpan
    });
    const competitorCounts = computeCompetitorCounts(created);
    const fresh = filterFresh(created, head, cfg);
    console.log(
      `[freshScan] ${chain.key}/${dex}: ${created.length} created in last ` +
        `${head - fromBlock} blocks, ${fresh.length} fresh (<= ${cfg.maxAgeBlocks} blocks old).`
    );

    for (const f of fresh) {
      try {
        const rec = await readPair(provider, f.pair, f.feeBps, { factory: f.factory, dex: f.dex });
        // Attach freshness + contention metadata (additive; downstream ignores unknown keys).
        rec.createdBlock = f.createdBlock;
        rec.ageBlocks = f.ageBlocks;
        rec.competitorCount = competitorCounts.get(f.pair) || 0;
        pools.push(rec);
      } catch (err) {
        console.warn(`[freshScan] failed reading fresh pair ${f.pair} on ${dex}: ${err.message}`);
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
    blockNumber: head,
    baseToken: chain.baseToken.address,
    baseTokenSymbol: chain.baseToken.symbol,
    takenAtIso: new Date().toISOString(),
    // Provenance marker so a fresh-pool snapshot is distinguishable from a full scanner.js one.
    snapshotKind: 'fresh',
    freshScan: { lookbackBlocks: cfg.lookbackBlocks, maxAgeBlocks: cfg.maxAgeBlocks, fromBlock, headBlock: head },
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
 * CLI entrypoint: scan all enabled chains for fresh pools, one snapshot per chain.
 */
async function main() {
  const { config, sourcePath } = loadConfig();
  console.log(`[freshScan] config: ${sourcePath}`);
  const chains = enabledChains(config);
  if (chains.length === 0) {
    console.warn('[freshScan] no enabled chains. Enable one in research/config.json.');
    return;
  }

  for (const chain of chains) {
    console.log(`[freshScan] scanning ${chain.key} (chainId ${chain.cfg.chainId}) for fresh pools...`);
    const snapshot = await scanFreshChain(chain, config);
    if (!snapshot) continue;

    const base =
      (config.freshScan && config.freshScan.snapshotOutPath) ||
      (config.scan && config.scan.snapshotOutPath) ||
      'research/data/snapshot.json';
    const ext = path.extname(base);
    // Canonical fresh filename: snapshot.<chain>.fresh.json (distinct from the full scan).
    const outPath = `${base.slice(0, base.length - ext.length)}.${chain.key}.fresh${ext}`;
    const written = writeSnapshot(snapshot, outPath);
    console.log(
      `[freshScan] ${chain.key}: ${snapshot.pools.length} fresh pools @ block ${snapshot.blockNumber} -> ${written}`
    );
  }
}

module.exports = {
  DEFAULTS,
  PAIR_CREATED_ABI,
  PAIR_CREATED_TOPIC,
  replayPairCreated,
  computeCompetitorCounts,
  filterFresh,
  scanFreshChain,
  writeSnapshot
};

if (require.main === module) {
  main().catch((err) => {
    console.error('[freshScan] fatal:', err);
    process.exitCode = 1;
  });
}
