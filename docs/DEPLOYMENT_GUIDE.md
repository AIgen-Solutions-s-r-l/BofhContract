# BofhContract V2 - Deployment Guide

**Version**: v1.5.0
**Last Updated**: 2025-11-11
**Target Networks**: BSC Testnet, BSC Mainnet

## Table of Contents

1. [Pre-Deployment Checklist](#pre-deployment-checklist)
2. [Environment Setup](#environment-setup)
3. [Deployment Process](#deployment-process)
4. [Post-Deployment Verification](#post-deployment-verification)
5. [Configuration](#configuration)
6. [Monitoring Setup](#monitoring-setup)
7. [Troubleshooting](#troubleshooting)
8. [Rollback Procedures](#rollback-procedures)

## Pre-Deployment Checklist

### Code Readiness

- [ ] All tests passing (291/291)
- [ ] Test coverage ≥80% (currently 80.43%)
- [ ] Security review completed
- [ ] Gas optimization analysis done
- [ ] Code frozen (no changes during deployment)
- [ ] Git tag created for deployment version

### Infrastructure Readiness

- [ ] Deployer wallet funded (minimum 0.5 BNB for testnet, 2 BNB for mainnet)
- [ ] Multi-sig wallet prepared (for mainnet)
- [ ] BSCScan API key configured
- [ ] RPC endpoints tested and reliable
- [ ] Monitoring infrastructure ready

### Documentation Readiness

- [ ] Deployment plan reviewed by team
- [ ] Emergency contacts list prepared
- [ ] Incident response plan documented
- [ ] User communication plan ready

### Security Readiness

- [ ] Professional audit completed (mainnet only)
- [ ] Bug bounty program prepared
- [ ] Private key security verified
- [ ] Backup procedures tested

## Environment Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create or verify `env.json`:

```json
{
  "mnemonic": "your twelve word mnemonic phrase here for deployment wallet",
  "BSCSCANAPIKEY": "your-bscscan-api-key-here"
}
```

⚠️ **Security Warning**: Never commit `env.json` to version control!

### 3. Verify Configuration

Check `hardhat.config.js` networks:

```javascript
networks: {
  bscTestnet: {
    url: "https://data-seed-prebsc-1-s1.binance.org:8545",
    chainId: 97,
    accounts: { mnemonic: mnemonic },
    gasPrice: 10000000000, // 10 gwei
  },
  bscMainnet: {
    url: "https://bsc-dataseed1.binance.org",
    chainId: 56,
    accounts: { mnemonic: mnemonic },
    gasPrice: 5000000000, // 5 gwei
  }
}
```

### 4. Test Network Connectivity

```bash
# Test BSC Testnet
npx hardhat run scripts/deploy.js --network bscTestnet --dry-run

# Check balance
npx hardhat console --network bscTestnet
> (await ethers.getSigners())[0].address
> ethers.formatEther(await ethers.provider.getBalance("YOUR_ADDRESS"))
```

## Deployment Process

### BSC Testnet Deployment

#### Step 1: Pre-Flight Checks

```bash
# Compile contracts
npx hardhat compile

# Run full test suite
npx hardhat test

# Generate coverage report
npx hardhat coverage

# Check deployer balance
npx hardhat console --network bscTestnet
> ethers.formatEther(await ethers.provider.getBalance((await ethers.getSigners())[0].address))
```

Minimum balance required: **0.5 BNB**

#### Step 2: Deploy to Testnet

```bash
# Deploy all contracts
npx hardhat run scripts/deploy.js --network bscTestnet
```

Expected output:
```
🚀 Starting BofhContract deployment...

Network: bscTestnet
Deployer: 0x...
Balance: X.XX BNB

📚 STEP 1: Deploying Libraries
   ✅ MathLib deployed: 0x...
   ✅ SecurityLib deployed: 0x...
   ✅ PoolLib deployed: 0x...

🏗️  STEP 2: Base Infrastructure
   ✅ Using BSC Testnet WBNB: 0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd
   ✅ Using PancakeSwap V2 Factory: 0x6725F303b657a9451d8BA641348b6761A6CC7a17

📝 STEP 3: Deploying BofhContractV2
   ✅ BofhContractV2 deployed to: 0x...

💾 Deployment saved to: deployments/bscTestnet.json

✅ Deployment completed successfully!
```

Deployment time: ~2-3 minutes

#### Step 3: Verify Contracts

```bash
# Wait 30-60 seconds for BSCScan to index the contract
sleep 60

# Verify all contracts
npx hardhat run scripts/verify.js --network bscTestnet
```

Expected output:
```
🔍 Starting contract verification...

📚 STEP 1: Verifying Libraries
   ✅ MathLib verified
   ✅ SecurityLib verified
   ✅ PoolLib verified

📝 STEP 2: Verifying BofhContractV2
   ✅ BofhContractV2 verified

🔗 View on BSCScan:
   https://testnet.bscscan.com/address/0x...#code
```

#### Step 4: Configure Contract

```bash
# Run configuration script
npx hardhat run scripts/configure.js --network bscTestnet
```

This script:
- Verifies deployment
- Configures risk parameters (if needed)
- Sets up MEV protection
- Tests basic functionality

### BSC Mainnet Deployment

⚠️ **CRITICAL**: Mainnet deployment requires additional precautions!

#### Prerequisites

1. **Security Audit**: Professional audit completed and findings resolved
2. **Testnet Testing**: Contract deployed and tested on testnet for ≥2 weeks
3. **Bug Bounty**: Program launched and active
4. **Multi-Sig**: Wallet prepared for ownership transfer
5. **Insurance**: Smart contract insurance in place
6. **Monitoring**: Production monitoring infrastructure ready
7. **Team Availability**: Full team available for 24-48 hours post-deployment

#### Step 1: Final Checks

```bash
# Verify mainnet configuration
npx hardhat run scripts/deploy.js --network bscMainnet --dry-run

# Check deployer balance (need 2+ BNB)
npx hardhat console --network bscMainnet
> ethers.formatEther(await ethers.provider.getBalance((await ethers.getSigners())[0].address))
```

#### Step 2: Deploy to Mainnet

```bash
# Deploy (with confirmation prompts)
npx hardhat run scripts/deploy.js --network bscMainnet
```

**⚠️ WARNING**: You will see a prompt:
```
⚠️  WARNING: You are deploying to MAINNET!
   Please confirm this is intentional.
```

Type `yes` to continue.

#### Step 3: Verify on BSCScan

```bash
# Wait for indexing
sleep 120

# Verify contracts
npx hardhat run scripts/verify.js --network bscMainnet
```

#### Step 4: Transfer Ownership to Multi-Sig

```bash
npx hardhat console --network bscMainnet
```

```javascript
const bofhAddress = "YOUR_DEPLOYED_ADDRESS";
const multiSigAddress = "YOUR_MULTISIG_ADDRESS";

const BofhContract = await ethers.getContractFactory("BofhContractV2");
const bofh = BofhContract.attach(bofhAddress);

// Transfer ownership
const tx = await bofh.transferOwnership(multiSigAddress);
await tx.wait();

console.log("Ownership transferred to:", await bofh.admin());
```

#### Step 5: Initial Configuration (via Multi-Sig)

Use Gnosis Safe interface to:
1. Verify ownership transfer
2. Configure risk parameters
3. Enable MEV protection
4. Set up monitoring alerts

## Post-Deployment Verification

### Automated Checks

Run the post-deployment verification script:

```bash
npx hardhat run scripts/post-deployment-verify.js --network <network>
```

This checks:
- Contract deployed and verified
- Ownership correct
- Base token and factory addresses correct
- Initial state correct (not paused, etc.)
- Risk parameters set to defaults
- Events emitting correctly

### Manual Checks

#### 1. Contract State Verification

```bash
npx hardhat console --network <network>
```

```javascript
const bofh = await ethers.getContractAt("BofhContractV2", "DEPLOYED_ADDRESS");

// Verify immutables
console.log("Base Token:", await bofh.getBaseToken());
console.log("Factory:", await bofh.getFactory());

// Verify owner
console.log("Owner:", await bofh.admin());

// Verify pause state
console.log("Paused:", await bofh.isPaused());

// Verify risk parameters
const params = await bofh.getRiskParams();
console.log("Risk Parameters:", params);

// Verify MEV protection
const mevConfig = await bofh.getMEVProtectionConfig();
console.log("MEV Config:", mevConfig);
```

#### 2. Test Swap Execution

```bash
# Run integration test
npx hardhat test test/Integration.test.js --network <network>
```

Or manually:

```javascript
// Approve tokens
const baseToken = await ethers.getContractAt("IERC20", BASE_TOKEN_ADDRESS);
await baseToken.approve(bofh.address, ethers.parseEther("1000"));

// Execute test swap
const path = [BASE_TOKEN, TOKEN_A, BASE_TOKEN];
const fees = [3, 3]; // 0.3%
const amountIn = ethers.parseEther("10");
const minOut = ethers.parseEther("9");
const deadline = Math.floor(Date.now() / 1000) + 3600;

const tx = await bofh.executeSwap(path, fees, amountIn, minOut, deadline);
const receipt = await tx.wait();

console.log("Gas used:", receipt.gasUsed.toString());
console.log("Status:", receipt.status === 1 ? "Success" : "Failed");
```

#### 3. BSCScan Verification

1. Navigate to contract on BSCScan
2. Verify:
   - Contract verified (green checkmark)
   - Source code visible
   - Read/Write functions accessible
   - Events tab shows deployment event

#### 4. Monitor Initial Transactions

Watch for first 24 hours:
- Transaction success rate
- Gas usage patterns
- Error frequency
- MEV protection triggers

## Configuration

### Risk Parameters

Default values (set during deployment):

```solidity
maxTradeVolume: 1000 * PRECISION (1000 tokens)
minPoolLiquidity: 100 * PRECISION (100 tokens)
maxPriceImpact: 10 (10%)
sandwichProtectionBips: 50 (0.5%)
```

To update (owner only):

```javascript
await bofh.updateRiskParams(
  ethers.parseEther("2000"), // maxTradeVolume
  ethers.parseEther("200"),  // minPoolLiquidity
  15,                         // maxPriceImpact (15%)
  75                          // sandwichProtectionBips (0.75%)
);
```

### MEV Protection

Default configuration:

```javascript
{
  enabled: false,           // Disabled by default
  maxTxPerBlock: 3,         // Max 3 transactions per block per user
  minTxDelay: 12            // Min 12 seconds between transactions
}
```

To enable:

```javascript
await bofh.configureMEVProtection(
  true,  // enabled
  3,     // maxTxPerBlock
  12     // minTxDelay (seconds)
);
```

### Pool Blacklisting

Blacklist suspicious or compromised pools:

```javascript
await bofh.setPoolBlacklist(poolAddress, true); // blacklist
await bofh.setPoolBlacklist(poolAddress, false); // whitelist
```

## Monitoring Setup

### On-Chain Monitoring

Monitor these events:

- `SwapExecuted` - All swap activity
- `RiskParamsUpdated` - Parameter changes
- `PoolBlacklisted` - Pool blacklist changes
- `OwnershipTransferred` - Ownership changes
- `SecurityStateChanged` - Pause events
- `AnomalyDetected` - Security alerts

### Off-Chain Monitoring

Setup alerts for:

1. **High Gas Usage**: Swaps using >500k gas
2. **Failed Transactions**: Success rate <95%
3. **MEV Triggers**: Frequent flash loan detections
4. **Unusual Volume**: Sudden spikes in activity
5. **Contract Paused**: Emergency pause triggered

Recommended tools:
- Tenderly for transaction monitoring
- OpenZeppelin Defender for automated alerts

## Troubleshooting

### Common Deployment Issues

#### Issue: Insufficient Balance

```
Error: sender doesn't have enough funds
```

**Solution**: Fund deployer wallet with sufficient BNB

#### Issue: Nonce Too Low

```
Error: nonce has already been used
```

**Solution**: Reset Hardhat network or wait for pending transactions

```bash
npx hardhat clean
```

#### Issue: Verification Failed

```
Error: Contract source code already verified
```

**Solution**: This is actually okay - contract was already verified

#### Issue: Contract Not Found

```
Error: cannot estimate gas; transaction may fail
```

**Solution**:
1. Check network connectivity
2. Verify base token and factory addresses
3. Ensure deployer has sufficient gas

### Common Post-Deployment Issues

#### Issue: Swap Reverts with "InvalidPath"

**Cause**: Path doesn't start and end with base token
**Solution**: Ensure path[0] === path[path.length-1] === baseToken

#### Issue: Swap Reverts with "InsufficientLiquidity"

**Cause**: Pool has low liquidity
**Solution**: Either add liquidity or lower minAmountOut

#### Issue: "FlashLoanDetected" Error

**Cause**: Multiple transactions in same block
**Solution**: Wait 12+ seconds between transactions or disable MEV protection

## Rollback Procedures

### Emergency Pause

If critical issue discovered:

```javascript
// Owner/Multi-sig only
await bofh.pause();
```

This:
- Stops all swaps
- Enables emergency token recovery
- Preserves user funds in contracts

### Emergency Token Recovery

If contract paused and tokens stuck:

```javascript
// Owner only, contract must be paused
await bofh.emergencyTokenRecovery(
  tokenAddress,
  recipientAddress,
  amount
);
```

### Ownership Transfer

If deployer wallet compromised:

```javascript
// Old owner
await bofh.transferOwnership(newOwnerAddress);
```

### Contract Upgrade (Future)

Current contract is **not upgradeable**. To upgrade:

1. Deploy new version
2. Pause old contract
3. Migrate liquidity to new contract
4. Update frontend to use new address
5. Communicate changes to users

## Deployment Checklist Summary

### Pre-Deployment

- [ ] All tests passing
- [ ] Security audit completed (mainnet)
- [ ] Multi-sig wallet ready (mainnet)
- [ ] Deployer wallet funded
- [ ] Team on standby

### Deployment

- [ ] Deploy contracts
- [ ] Verify on BSCScan
- [ ] Configure risk parameters
- [ ] Enable MEV protection (if desired)
- [ ] Transfer ownership (mainnet)

### Post-Deployment

- [ ] Verify contract state
- [ ] Test swap execution
- [ ] Setup monitoring
- [ ] Monitor for 24-48 hours
- [ ] Communicate deployment to users

### Week 1

- [ ] Monitor transaction patterns
- [ ] Adjust risk parameters if needed
- [ ] Respond to any issues
- [ ] Gather user feedback
- [ ] Document any incidents

## Support and Resources

### Documentation

- Architecture: `docs/ARCHITECTURE.md`
- Security: `docs/SECURITY_REVIEW.md`
- Gas Optimization: `docs/GAS_OPTIMIZATION_ANALYSIS.md`
- Test Suite: `docs/TEST_SUITE_IMPROVEMENTS.md`

### Scripts

- Deployment: `scripts/deploy.js`
- Verification: `scripts/verify.js`
- Configuration: `scripts/configure.js`

### External Resources

- BSC Testnet Faucet: https://testnet.binance.org/faucet-smart
- BSCScan Testnet: https://testnet.bscscan.com
- BSCScan Mainnet: https://bscscan.com
- PancakeSwap Docs: https://docs.pancakeswap.finance

### Emergency Contacts

- Development Team: [ADD CONTACT INFO]
- Security Team: [ADD CONTACT INFO]
- BSC Support: [ADD CONTACT INFO]

---

**Document Version**: 1.0
**Last Reviewed**: 2025-11-11
**Next Review**: Before mainnet deployment

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
