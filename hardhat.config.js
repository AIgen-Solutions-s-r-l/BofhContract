// Import individual plugins instead of toolbox to avoid ignition peer dependency conflict
// Note: hardhat-toolbox includes ignition which has peer dependency conflicts
// We import only what we need
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-network-helpers");
require("@nomicfoundation/hardhat-verify");
require("hardhat-gas-reporter");
require("solidity-coverage");

// Import environment configuration (same format as Truffle)
// Fallback to placeholder values in CI where env.json doesn't exist
let mnemonic, BSCSCANAPIKEY;
try {
  const env = require('./env.json');
  mnemonic = env.mnemonic;
  BSCSCANAPIKEY = env.BSCSCANAPIKEY;
} catch (e) {
  // Use placeholder values for CI/CD
  mnemonic = "test test test test test test test test test test test junk";
  BSCSCANAPIKEY = "placeholder";
}

// Shared signer config for all live networks
const accounts = { mnemonic };

// Per-chain block-explorer API keys (env-overridable; fall back to env.json's BSCSCANAPIKEY for BSC)
const BSCSCAN_KEY = process.env.BSCSCAN_API_KEY || BSCSCANAPIKEY;
const POLYGONSCAN_KEY = process.env.POLYGONSCAN_API_KEY || "placeholder";
const BASESCAN_KEY = process.env.BASESCAN_API_KEY || "placeholder";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.10",
    settings: {
      // Pin the EVM target: solc 0.8.10 defaults to "london" (PUSH0-free). Pinning prevents a
      // future solc bump from silently emitting PUSH0/MCOPY and bricking deploys on chains that
      // lag Shanghai/Cancun. Override per-chain via EVM_VERSION (e.g. "paris", "cancun").
      evmVersion: process.env.EVM_VERSION || "london",
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },

  // EVM-compatible networks. RPC URLs are env-overridable; all use the same mnemonic-derived signer.
  // Adding a chain = one entry here + (for verification) one apiKey below.
  networks: {
    // Local Hardhat network (replaces Ganache)
    hardhat: {
      chainId: 31337,
      accounts: {
        mnemonic: mnemonic,
        count: 10
      }
    },

    // --- BNB Smart Chain ---
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545",
      chainId: 97,
      accounts,
      gasPrice: 10000000000, // 10 gwei
      timeout: 100000
    },
    bsc: {
      url: process.env.BSC_RPC || "https://bsc-dataseed1.binance.org",
      chainId: 56,
      accounts
    },

    // --- Polygon PoS ---
    polygon: {
      url: process.env.POLYGON_RPC || "https://polygon-rpc.com",
      chainId: 137,
      accounts
    },
    polygonAmoy: {
      url: process.env.POLYGON_AMOY_RPC || "https://rpc-amoy.polygon.technology",
      chainId: 80002,
      accounts
    },

    // --- Base ---
    base: {
      url: process.env.BASE_RPC || "https://mainnet.base.org",
      chainId: 8453,
      accounts
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
      chainId: 84532,
      accounts
    }
  },

  // Gas reporter configuration
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    outputFile: "gas-report.txt",
    noColors: true
  },

  // Block-explorer verification (hardhat-verify). Per-chain keys, env-overridable.
  etherscan: {
    apiKey: {
      bsc: BSCSCAN_KEY,
      bscTestnet: BSCSCAN_KEY,
      polygon: POLYGONSCAN_KEY,
      polygonAmoy: POLYGONSCAN_KEY,
      base: BASESCAN_KEY,
      baseSepolia: BASESCAN_KEY
    }
  },

  // Path configuration (match Truffle structure)
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  },

  // Mocha test configuration
  mocha: {
    timeout: 100000
  },

  // Coverage configuration - Note: mocks are test utilities, not production code
  // Production code coverage (libs/ and main/) is >93%
};
