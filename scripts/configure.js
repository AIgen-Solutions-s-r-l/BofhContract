const hre = require('hardhat');
const { ethers } = require('hardhat');
const { loadDeployment, waitForTx, parseAmount } = require('./utils/helpers');
const { isTestNetwork, isLocalNetwork } = require('./utils/addresses');

async function main() {
  console.log('\n⚙️  Starting contract configuration...\n');

  const networkName = hre.network.name;
  const [deployer] = await ethers.getSigners();

  console.log(`Network: ${networkName}`);
  console.log(`Deployer: ${deployer.address}\n`);

  // Load deployment data
  const deployment = loadDeployment(networkName);
  if (!deployment) {
    console.error(`❌ No deployment found for network: ${networkName}`);
    console.log(`   Run deployment first: npm run deploy`);
    process.exit(1);
  }

  console.log(`📝 Loaded deployment: ${deployment.contracts.BofhContractV2}\n`);

  // Get contract instance
  const contract = await ethers.getContractAt(
    'BofhContractV2',
    deployment.contracts.BofhContractV2
  );

  // ==================================================================
  // Step 1: Configure Risk Parameters
  // ==================================================================
  console.log('📊 STEP 1: Configuring Risk Parameters\n');

  // Risk tiers, selected from network metadata (not hardcoded names). Any unknown LIVE
  // network falls through to the conservative mainnet tier — never the permissive one.
  const RISK_TIERS = {
    mainnet: { maxTradeVolume: '100',   minPoolLiquidity: '50',  maxPriceImpact: '0.05', sandwichProtectionBips: 25,  label: 'PRODUCTION (conservative)' },
    testnet: { maxTradeVolume: '1000',  minPoolLiquidity: '100', maxPriceImpact: '0.10', sandwichProtectionBips: 50,  label: 'TESTNET (moderate)' },
    local:   { maxTradeVolume: '10000', minPoolLiquidity: '10',  maxPriceImpact: '0.10', sandwichProtectionBips: 100, label: 'LOCAL (permissive for testing)' }
  };

  const tierName = isLocalNetwork(networkName)
    ? 'local'
    : isTestNetwork(networkName)
      ? 'testnet'
      : 'mainnet'; // unknown live network -> conservative, not permissive
  const tier = RISK_TIERS[tierName];

  const riskParams = {
    maxTradeVolume: parseAmount(tier.maxTradeVolume, 6),
    minPoolLiquidity: parseAmount(tier.minPoolLiquidity, 6),
    maxPriceImpact: parseAmount(tier.maxPriceImpact, 6),
    sandwichProtectionBips: tier.sandwichProtectionBips
  };
  console.log(`   Using ${tier.label} parameters`);

  console.log('\n   Parameters:');
  console.log(`      Max Trade Volume: ${ethers.formatUnits(riskParams.maxTradeVolume, 6)}`);
  console.log(`      Min Pool Liquidity: ${ethers.formatUnits(riskParams.minPoolLiquidity, 6)}`);
  console.log(`      Max Price Impact: ${ethers.formatUnits(riskParams.maxPriceImpact, 6) * 100}%`);
  console.log(`      Sandwich Protection: ${riskParams.sandwichProtectionBips / 100}%\n`);

  const updateTx = await contract.updateRiskParams(
    riskParams.maxTradeVolume,
    riskParams.minPoolLiquidity,
    riskParams.maxPriceImpact,
    riskParams.sandwichProtectionBips
  );
  await waitForTx(updateTx, 'Update risk parameters');

  // ==================================================================
  // Step 2: Configure MEV Protection
  // ==================================================================
  console.log('\n🔒 STEP 2: Configuring MEV Protection\n');

  const mevEnabled = networkName !== 'hardhat' && networkName !== 'localhost';
  const maxTxPerBlock = 3;      // Max 3 transactions per block
  const minTxDelay = 12;        // 12 seconds between transactions

  console.log(`   MEV Protection: ${mevEnabled ? 'ENABLED' : 'DISABLED'}`);
  if (mevEnabled) {
    console.log(`   Max Tx Per Block: ${maxTxPerBlock}`);
    console.log(`   Min Tx Delay: ${minTxDelay}s\n`);
  } else {
    console.log(`   (Disabled for local testing)\n`);
  }

  const mevTx = await contract.configureMEVProtection(
    mevEnabled,
    maxTxPerBlock,
    minTxDelay
  );
  await waitForTx(mevTx, 'Configure MEV protection');

  // ==================================================================
  // Step 3: Verify Configuration
  // ==================================================================
  console.log('\n✅ STEP 3: Verifying Configuration\n');

  const [maxVol, minLiq, maxImpact, sandwich] = await contract.getRiskParameters();
  console.log('   Risk Parameters (verified):');
  console.log(`      Max Trade Volume: ${ethers.formatUnits(maxVol, 6)}`);
  console.log(`      Min Pool Liquidity: ${ethers.formatUnits(minLiq, 6)}`);
  console.log(`      Max Price Impact: ${ethers.formatUnits(maxImpact, 6) * 100}%`);
  console.log(`      Sandwich Protection: ${sandwich / 100}%`);

  const [enabled, maxTx, minDelay] = await contract.getMEVProtectionConfig();
  console.log('\n   MEV Protection (verified):');
  console.log(`      Enabled: ${enabled}`);
  console.log(`      Max Tx Per Block: ${maxTx}`);
  console.log(`      Min Tx Delay: ${minDelay}s`);

  const admin = await contract.getAdmin();
  const paused = await contract.isPaused();
  console.log('\n   Contract State:');
  console.log(`      Admin: ${admin}`);
  console.log(`      Paused: ${paused}`);

  // ==================================================================
  // Summary
  // ==================================================================
  console.log('\n' + '='.repeat(60));
  console.log('✅ CONFIGURATION COMPLETED');
  console.log('='.repeat(60));
  console.log(`Network: ${networkName}`);
  console.log(`Contract: ${deployment.contracts.BofhContractV2}`);
  console.log(`\nContract is ready for use!`);
  console.log('='.repeat(60) + '\n');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ Configuration failed:\n', error);
    process.exit(1);
  });
