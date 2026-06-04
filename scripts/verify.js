const hre = require('hardhat');
const { loadDeployment, verifyContract, delay } = require('./utils/helpers');
const { isLocalNetwork } = require('./utils/addresses');

// Block-explorer base URLs per network (used only for the post-verification link).
const EXPLORERS = {
  bsc: 'https://bscscan.com',
  bscTestnet: 'https://testnet.bscscan.com',
  polygon: 'https://polygonscan.com',
  polygonAmoy: 'https://amoy.polygonscan.com',
  base: 'https://basescan.org',
  baseSepolia: 'https://sepolia.basescan.org'
};

async function main() {
  console.log('\n🔍 Starting contract verification...\n');

  const networkName = hre.network.name;
  console.log(`Network: ${networkName}\n`);

  // Load deployment data
  const deployment = loadDeployment(networkName);
  if (!deployment) {
    console.error(`❌ No deployment found for network: ${networkName}`);
    console.log(`   Run deployment first: npm run deploy:${networkName}`);
    process.exit(1);
  }

  console.log(`📝 Loaded deployment from: deployments/${networkName}.json\n`);

  // Skip verification only on local networks (no public explorer). Any live EVM
  // network is supported via hardhat-verify + the per-chain etherscan config.
  if (isLocalNetwork(networkName)) {
    console.log('ℹ️  Skipping verification on local network');
    process.exit(0);
  }

  // ==================================================================
  // Step 1: Verify Libraries
  // ==================================================================
  console.log('📚 STEP 1: Verifying Libraries\n');

  try {
    await verifyContract(
      hre,
      deployment.libraries.MathLib,
      [] // No constructor arguments
    );
    await delay(2000); // Rate limiting

    await verifyContract(
      hre,
      deployment.libraries.SecurityLib,
      []
    );
    await delay(2000);

    await verifyContract(
      hre,
      deployment.libraries.PoolLib,
      [],
      {} // No library dependencies shown in verification
    );
    await delay(2000);

  } catch (error) {
    console.error('❌ Library verification failed:', error.message);
    // Continue anyway - libraries might already be verified
  }

  // ==================================================================
  // Step 2: Verify Main Contract
  // ==================================================================
  console.log('\n📝 STEP 2: Verifying BofhContractV2\n');

  try {
    await verifyContract(
      hre,
      deployment.contracts.BofhContractV2,
      [
        deployment.config.baseToken,
        deployment.config.factory
      ],
      {
        'contracts/libs/MathLib.sol:MathLib': deployment.libraries.MathLib,
        'contracts/libs/SecurityLib.sol:SecurityLib': deployment.libraries.SecurityLib,
        'contracts/libs/PoolLib.sol:PoolLib': deployment.libraries.PoolLib
      }
    );
  } catch (error) {
    console.error('❌ Main contract verification failed:', error.message);
    process.exit(1);
  }

  // ==================================================================
  // Summary
  // ==================================================================
  console.log('\n' + '='.repeat(60));
  console.log('✅ VERIFICATION COMPLETED');
  console.log('='.repeat(60));
  console.log(`Network: ${networkName}`);
  console.log(`\nVerified contracts:`);
  console.log(`   MathLib: ${deployment.libraries.MathLib}`);
  console.log(`   SecurityLib: ${deployment.libraries.SecurityLib}`);
  console.log(`   PoolLib: ${deployment.libraries.PoolLib}`);
  console.log(`   BofhContractV2: ${deployment.contracts.BofhContractV2}`);

  const explorerUrl = EXPLORERS[networkName];
  if (explorerUrl) {
    console.log(`\n🔗 View on explorer:`);
    console.log(`   ${explorerUrl}/address/${deployment.contracts.BofhContractV2}#code`);
  }
  console.log('='.repeat(60) + '\n');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ Verification failed:\n', error);
    process.exit(1);
  });
