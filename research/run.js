'use strict';

/**
 * Thin orchestrator that runs the offline Stage 2->4 pipeline over an EXISTING snapshot
 * file, so the path-finder + backtester can be exercised with zero RPC. Use this to
 * sanity-check the toolkit and to replay a recorded snapshot.
 *
 * Usage:
 *   node research/run.js <snapshot.json>
 *   node research/run.js --demo            # build a tiny in-memory snapshot and run it
 *
 * For live scanning use:  node research/scanner.js   (needs RPC env vars; see README)
 */

const fs = require('fs');
const path = require('path');

const { loadConfig } = require('./config.js');
const { findCandidateCycles } = require('./pathfinder.js');
const { runBacktest, printReport } = require('./backtester.js');

/**
 * A tiny synthetic snapshot with a deliberate triangular arbitrage, so the pipeline
 * produces a non-empty report offline without any chain access. NOT representative —
 * for wiring/smoke-testing only.
 * @returns {object} snapshot
 */
function demoSnapshot() {
  const BASE = '0x0000000000000000000000000000000000000B45';
  const A = '0x000000000000000000000000000000000000000A';
  const B = '0x000000000000000000000000000000000000000B';
  const e = (n) => (BigInt(n) * 10n ** 18n).toString();
  return {
    version: 1,
    chainKey: 'demo',
    chainId: 0,
    blockNumber: 0,
    baseToken: BASE,
    baseTokenSymbol: 'WBASE',
    takenAtIso: new Date().toISOString(),
    tokens: {
      [BASE]: { symbol: 'WBASE', decimals: 18, probed: true },
      [A]: { symbol: 'AAA', decimals: 18, probed: true },
      [B]: { symbol: 'BBB', decimals: 18, probed: true }
    },
    // Reserves are skewed so BASE->A->B->BASE round-trips for a small marginal edge.
    pools: [
      { pair: '0x00000000000000000000000000000000000000P1', dex: 'DexX', token0: BASE, token1: A, reserve0: e(1000), reserve1: e(2050), feeBps: 25 },
      { pair: '0x00000000000000000000000000000000000000P2', dex: 'DexY', token0: A, token1: B, reserve0: e(2000), reserve1: e(1000), feeBps: 25 },
      { pair: '0x00000000000000000000000000000000000000P3', dex: 'DexZ', token0: B, token1: BASE, reserve0: e(1000), reserve1: e(1010), feeBps: 25 }
    ]
  };
}

function loadSnapshot(arg) {
  if (arg === '--demo' || !arg) return demoSnapshot();
  const abs = path.isAbsolute(arg) ? arg : path.join(process.cwd(), arg);
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

async function main() {
  const arg = process.argv[2];
  const { config } = loadConfig();
  const snapshot = loadSnapshot(arg);

  const kind = snapshot.snapshotKind === 'fresh' ? ' [FRESH-POOL]' : '';
  console.log(
    `[run] snapshot chain=${snapshot.chainKey} block=${snapshot.blockNumber} ` +
      `pools=${(snapshot.pools || []).length} base=${snapshot.baseToken}${kind}`
  );

  const candidates = findCandidateCycles(snapshot, config.pathfinder || {});
  console.log(`[run] candidate cycles: ${candidates.length}`);

  // obs left mostly empty on purpose: win-rate falls back to config, revert-rate is
  // unmeasured (forces a provisional verdict + the revm TODO warning). The token-safety GATE
  // runs offline here (no provider) → pass-through unless an injectedSafety map is provided;
  // it becomes a hard gate the moment a provider/router is wired (see backtester.runBacktest).
  const result = await runBacktest(snapshot, candidates, config, { windowDays: 1 });
  printReport(result);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[run] fatal:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { demoSnapshot };
