'use strict';

/**
 * Config loader for the off-chain research toolkit.
 *
 * Responsibilities:
 *  - Load research/config.json (falling back to config.example.json so the skeleton
 *    runs out of the box for inspection).
 *  - Resolve RPC URLs from environment variables (never from the JSON itself).
 *  - Cross-check factory addresses against the canonical table in
 *    scripts/utils/addresses.js and WARN on drift (single source of truth lives there).
 *  - Resolve each chain's base token address from scripts/utils/addresses.js.
 *
 * This module is dependency-light on purpose (no ethers, no hardhat) so config can be
 * validated in isolation and unit-tested offline.
 */

const fs = require('fs');
const path = require('path');

// Canonical multi-chain address book shared with the Solidity deploy scripts.
const addressBook = require('../scripts/utils/addresses.js');

const RESEARCH_DIR = __dirname;
const CONFIG_PATH = path.join(RESEARCH_DIR, 'config.json');
const EXAMPLE_PATH = path.join(RESEARCH_DIR, 'config.example.json');

/**
 * Load the research config, preferring config.json, falling back to the committed example.
 * @returns {{ config: object, sourcePath: string, isExample: boolean }}
 */
function loadConfig() {
  const usingExample = !fs.existsSync(CONFIG_PATH);
  const sourcePath = usingExample ? EXAMPLE_PATH : CONFIG_PATH;
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const config = JSON.parse(raw);
  if (usingExample) {
    console.warn(
      `[config] research/config.json not found — using ${path.basename(EXAMPLE_PATH)}. ` +
        'Copy it to config.json and fill in real RPC env vars before running against a live chain.'
    );
  }
  return { config, sourcePath, isExample: usingExample };
}

/**
 * Resolve the RPC URL for a chain from its configured env var.
 * @param {object} chainCfg - One entry from config.chains.
 * @param {{ allowFallback?: boolean }} [opts]
 * @returns {string|null} URL or null if the env var is unset.
 */
function resolveRpcUrl(chainCfg, opts = {}) {
  const primary = chainCfg.rpcEnv ? process.env[chainCfg.rpcEnv] : undefined;
  if (primary) return primary;
  if (opts.allowFallback && chainCfg.rpcFallbackEnv) {
    const fb = process.env[chainCfg.rpcFallbackEnv];
    if (fb) return fb;
  }
  return null;
}

/**
 * Resolve the WebSocket URL for a chain (for live newHeads subscriptions). May be null.
 * @param {object} chainCfg
 * @returns {string|null}
 */
function resolveWsUrl(chainCfg) {
  return chainCfg.wsEnv && process.env[chainCfg.wsEnv] ? process.env[chainCfg.wsEnv] : null;
}

/**
 * Resolve the base (wrapped-native) token address for a chain via the canonical address book.
 * Falls back to the symbol declared in the chain config if the book lacks the network.
 * @param {string} chainKey - Network key (e.g. "bsc"), must match addresses.js CHAIN_META.
 * @param {object} chainCfg
 * @returns {{ symbol: string, address: string|null }}
 */
function resolveBaseToken(chainKey, chainCfg) {
  const symbol = chainCfg.baseTokenSymbol || 'wrappedNative';
  try {
    // getBaseToken resolves CHAIN_META.wrappedNative for the network.
    const address = addressBook.getBaseToken(chainKey);
    return { symbol, address };
  } catch (_err) {
    // Unknown-to-addresses.js chain: caller must supply the address out of band.
    return { symbol, address: null };
  }
}

/**
 * Compare config factory addresses against scripts/utils/addresses.js and warn on drift.
 * Does not throw — drift is a signal, not a hard failure, since research chains may be
 * ahead of the canonical book.
 * @param {string} chainKey
 * @param {object} chainCfg
 * @returns {string[]} list of human-readable drift warnings (also printed)
 */
function auditFactoryDrift(chainKey, chainCfg) {
  const warnings = [];
  const canonical = (addressBook.FACTORIES || {})[chainKey] || {};
  const local = chainCfg.factories || {};
  for (const [dex, entry] of Object.entries(local)) {
    if (dex.startsWith('_')) continue;
    const want = canonical[dex];
    const have = (entry && entry.address) || '';
    if (want && want.toLowerCase() !== have.toLowerCase()) {
      const msg = `[config] factory drift on ${chainKey}.${dex}: config=${have} addresses.js=${want}`;
      warnings.push(msg);
      console.warn(msg);
    }
  }
  return warnings;
}

/**
 * Return the list of enabled chains with resolved RPC/base-token info, ready for the
 * scanner. RPC may be null when the env var is unset (skeleton-friendly; callers TODO).
 * @param {object} config
 * @returns {Array<{ key: string, cfg: object, rpcUrl: string|null, wsUrl: string|null, baseToken: object }>}
 */
function enabledChains(config) {
  const out = [];
  for (const [key, cfg] of Object.entries(config.chains || {})) {
    if (key.startsWith('_') || !cfg.enabled) continue;
    auditFactoryDrift(key, cfg);
    out.push({
      key,
      cfg,
      rpcUrl: resolveRpcUrl(cfg, { allowFallback: true }),
      wsUrl: resolveWsUrl(cfg),
      baseToken: resolveBaseToken(key, cfg)
    });
  }
  return out;
}

module.exports = {
  CONFIG_PATH,
  EXAMPLE_PATH,
  loadConfig,
  resolveRpcUrl,
  resolveWsUrl,
  resolveBaseToken,
  auditFactoryDrift,
  enabledChains
};
