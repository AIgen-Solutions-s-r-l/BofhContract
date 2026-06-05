// Network address book for BofhContract deployment.
//
// Multi-chain by design: each EVM network has an entry in CHAIN_META (wrapped-native
// symbol, default DEX, testnet flag) plus token/factory tables below. Adding a chain =
// add one CHAIN_META entry + the wrapped-native address in TOKENS + a factory in FACTORIES.
// Local networks (hardhat/localhost) intentionally have no static addresses — their
// tokens/factories are mock contracts deployed at runtime by scripts/deploy.js.

/**
 * Known token addresses per network. Keys are token symbols; the wrapped-native symbol
 * for each chain is declared in CHAIN_META and resolved by getBaseToken().
 */
const TOKENS = {
  // --- BNB Smart Chain ---
  bsc: {
    WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
    USDT: '0x55d398326f99059fF775485246999027B3197955',
    BTCB: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',
    ETH: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
    CAKE: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82'
  },
  bscTestnet: {
    WBNB: '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd',
    BUSD: '0xeD24FC36d5Ee211Ea25A80239Fb8C4Cfd80f12Ee', // BUSD-T
    USDT: '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd', // USDT-T
    DAI: '0xEC5dCb5Dbf4B114C9d0F65BcCAb49EC54F6A0867', // DAI-T
    CAKE: '0xFa60D973F7642B748046464e165A65B7323b0DEE'  // CAKE-T
  },

  // --- Polygon PoS ---
  polygon: {
    WMATIC: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC.e (bridged)
    USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    WETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619'
  },
  polygonAmoy: {
    // Fill wrapped-native (WMATIC) + tokens per deployment target.
  },

  // --- Base ---
  base: {
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  },
  baseSepolia: {
    // Fill wrapped-native (WETH) + tokens per deployment target.
  },

  // --- Local (mocks deployed at runtime) ---
  hardhat: {},
  localhost: {}
};

/**
 * Known factory addresses (Uniswap V2 / PancakeSwap-style) per network and DEX.
 */
const FACTORIES = {
  bsc: {
    PancakeSwapV2: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    BiswapV2: '0x858E3312ed3A876947EA49d572A7C42DE08af7EE',
    ApeSwapV2: '0x0841BD0B734E4F5853f0dD8d7Ea041c241fb0Da6'
  },
  bscTestnet: {
    PancakeSwapV2: '0x6725F303b657a9451d8BA641348b6761A6CC7a17'
  },

  polygon: {
    QuickSwapV2: '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32',
    SushiSwapV2: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4'
  },
  polygonAmoy: {},

  base: {
    UniswapV2: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6'
  },
  baseSepolia: {},

  hardhat: {},
  localhost: {}
};

/**
 * Per-chain metadata. `wrappedNative` is the TOKENS key used as the swap base token;
 * `defaultDex` is the FACTORIES key used when no DEX is specified; `isTestnet` drives
 * isTestNetwork(); `local` marks networks whose addresses are mock-deployed at runtime.
 */
const CHAIN_META = {
  bsc:         { wrappedNative: 'WBNB',   defaultDex: 'PancakeSwapV2', isTestnet: false },
  bscTestnet:  { wrappedNative: 'WBNB',   defaultDex: 'PancakeSwapV2', isTestnet: true  },
  polygon:     { wrappedNative: 'WMATIC', defaultDex: 'QuickSwapV2',   isTestnet: false },
  polygonAmoy: { wrappedNative: 'WMATIC', defaultDex: 'QuickSwapV2',   isTestnet: true  },
  base:        { wrappedNative: 'WETH',   defaultDex: 'UniswapV2',     isTestnet: false },
  baseSepolia: { wrappedNative: 'WETH',   defaultDex: 'UniswapV2',     isTestnet: true  },
  hardhat:     { isTestnet: true, local: true },
  localhost:   { isTestnet: true, local: true }
};

const LOCAL_NETWORKS = ['hardhat', 'localhost'];

/**
 * True for local dev networks whose contracts are mock-deployed at runtime.
 * @param {string} networkName
 * @returns {boolean}
 */
function isLocalNetwork(networkName) {
  return LOCAL_NETWORKS.includes(networkName);
}

/**
 * Get the wrapped-native (base) token address for a network.
 * @param {string} networkName
 * @returns {string} Wrapped-native token address
 */
function getBaseToken(networkName) {
  if (isLocalNetwork(networkName)) {
    throw new Error(`Base token for local network "${networkName}" is a mock deployed at runtime`);
  }
  const meta = CHAIN_META[networkName];
  if (!meta) {
    throw new Error(`Unknown network "${networkName}" — add it to CHAIN_META/TOKENS in scripts/utils/addresses.js`);
  }
  const addr = (TOKENS[networkName] || {})[meta.wrappedNative];
  if (!addr) {
    throw new Error(`Wrapped-native (${meta.wrappedNative}) address not set for "${networkName}" in TOKENS`);
  }
  return addr;
}

/**
 * Get a factory address for a network and DEX (defaults to the chain's default DEX).
 * @param {string} networkName
 * @param {string} [dex] - DEX name; defaults to CHAIN_META[networkName].defaultDex
 * @returns {string} Factory address
 */
function getFactory(networkName, dex) {
  if (isLocalNetwork(networkName)) {
    throw new Error(`Factory for local network "${networkName}" is a mock deployed at runtime`);
  }
  const meta = CHAIN_META[networkName];
  if (!meta) {
    throw new Error(`Unknown network "${networkName}" — add it to CHAIN_META/FACTORIES in scripts/utils/addresses.js`);
  }
  const dexName = dex || meta.defaultDex;
  const addr = (FACTORIES[networkName] || {})[dexName];
  if (!addr) {
    throw new Error(`Factory "${dexName}" not set for "${networkName}" in FACTORIES`);
  }
  return addr;
}

/**
 * Whether a network is a testnet or local network (derived from CHAIN_META, not a hardcoded list).
 * @param {string} networkName
 * @returns {boolean}
 */
function isTestNetwork(networkName) {
  const meta = CHAIN_META[networkName];
  return meta ? Boolean(meta.isTestnet) : false;
}

module.exports = {
  TOKENS,
  FACTORIES,
  CHAIN_META,
  getBaseToken,
  getFactory,
  isTestNetwork,
  isLocalNetwork
};
