# Deployment Checklist - v1.1.0

**Project**: BofhContract V2
**Version**: v1.1.0
**Target**: BSC Testnet
**Status**: Ready for Deployment ✅

---

## 🔐 Pre-Deployment Security Checklist

### Critical Actions Required

- [ ] **Rotate BSCScan API Key** (CRITICAL - MUST DO FIRST)
  - Current exposed key: `<REDACTED>`
  - Action: Visit https://bscscan.com/myapikey
  - Rotate the exposed key
  - Copy new API key

- [ ] **Create env.json Configuration**
  ```bash
  cp env.json.example env.json
  ```

- [ ] **Configure env.json**
  ```json
  {
    "mnemonic": "your twelve word mnemonic phrase for deployment wallet",
    "BSCSCANAPIKEY": "YOUR_NEW_BSCSCAN_API_KEY_HERE"
  }
  ```

- [ ] **Verify env.json is in .gitignore**
  ```bash
  grep "env.json" .gitignore
  # Should show: env.json
  ```

---

## 📦 Environment Setup

### 1. Install Dependencies
```bash
# Install npm packages
npm install --legacy-peer-deps

# Expected: ~1834 packages installed
```

### 2. Verify Node.js Version
```bash
node --version
# Current: v25.1.0
# Note: Ganache incompatible, but deployment works
```

### 3. Check Truffle Version
```bash
npx truffle version
# Expected: Truffle v5.11.5 (core: 5.11.5)
```

---

## 🔨 Build & Compile

### 1. Clean Build
```bash
# Remove old build artifacts
rm -rf build/contracts

# Compile all contracts
npx truffle compile --all

# Expected output:
# > Compiled successfully using:
#    - solc: 0.8.10+commit.fc410830.Emscripten.clang
```

### 2. Verify Compilation
- [ ] All 10 contracts compile successfully
- [ ] No errors (warnings are acceptable)
- [ ] Build artifacts in `build/contracts/`

**Expected Contracts**:
- ✅ BofhContract.sol
- ✅ BofhContractV2.sol
- ✅ BofhContractBase.sol
- ✅ SecurityLib.sol
- ✅ MathLib.sol
- ✅ PoolLib.sol
- ✅ MockToken.sol
- ✅ MockPair.sol
- ✅ MockFactory.sol
- ✅ ISwapInterfaces.sol

---

## 🧪 Pre-Deployment Testing

### 1. Local Testing (Optional - Blocked)
```bash
# Note: Tests currently blocked due to Ganache/Node.js incompatibility
# This is accepted technical debt for SPRINT 2

# If you want to test, you can:
# Option 1: Downgrade Node.js to v18 LTS
# Option 2: Wait for SPRINT 2 (Hardhat migration)
```

### 2. Contract Size Check
```bash
# Check contract sizes (must be < 24KB for deployment)
ls -lh build/contracts/*.json | awk '{print $9, $5}'
```

---

## 🌐 Network Configuration

### 1. Verify Truffle Config
```bash
# Check network settings
cat truffle-config.js | grep -A 5 "bsc:"

# Expected:
# - Network: BSC Testnet
# - RPC: https://data-seed-prebsc-1-s1.binance.org:8545
# - Network ID: 97
```

### 2. Test RPC Connection
```bash
# Verify BSC testnet is accessible
curl -X POST https://data-seed-prebsc-1-s1.binance.org:8545 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

# Should return current block number
```

### 3. Check Wallet Balance
```bash
# Your deployment wallet needs BNB for gas
# Get testnet BNB from: https://testnet.binance.org/faucet-smart
```

---

## 🚀 Deployment Process

### 1. Dry Run (Recommended)
```bash
# Run migration with --dry-run flag
npx truffle migrate --network bsc --dry-run

# Review:
# - Gas estimates
# - Contract sizes
# - Deployment order
```

### 2. Deploy to BSC Testnet
```bash
# Deploy contracts
npm run migrate

# Or with reset:
npx truffle migrate --network bsc --reset

# Expected:
# - Migrations contract deployed
# - BofhContractV2 deployed
# - All migrations successful
```

### 3. Save Deployment Addresses
```bash
# Contract addresses will be in:
cat build/contracts/BofhContractV2.json | jq '.networks["97"].address'

# Save these addresses for verification!
```

---

## ✅ Post-Deployment Verification

### 1. Verify Contracts on BSCScan
```bash
# Verify BofhContractV2
npx truffle run verify BofhContractV2@<CONTRACT_ADDRESS> --network bsc

# Expected: "Successfully verified"
```

### 2. Check Contract on BSCScan
- [ ] Visit: https://testnet.bscscan.com/address/<CONTRACT_ADDRESS>
- [ ] Verify contract is verified (green checkmark)
- [ ] Check contract creation transaction
- [ ] Review contract code on BSCScan

### 3. Test Basic Functions
```bash
# Using truffle console
npx truffle console --network bsc

# In console:
truffle(bsc)> const instance = await BofhContractV2.deployed()
truffle(bsc)> await instance.getAdmin()
# Should return your deployment wallet address

truffle(bsc)> await instance.getBaseToken()
# Should return base token address
```

---

## 📊 Deployment Checklist Summary

### Before Deployment
- [ ] Rotate BSCScan API key
- [ ] Create and configure env.json
- [ ] Install dependencies (npm install --legacy-peer-deps)
- [ ] Verify compilation (npx truffle compile --all)
- [ ] Check contract sizes
- [ ] Get testnet BNB from faucet

### During Deployment
- [ ] Run dry-run first (optional but recommended)
- [ ] Deploy with: npm run migrate
- [ ] Save all contract addresses
- [ ] Monitor deployment transaction

### After Deployment
- [ ] Verify contracts on BSCScan
- [ ] Test basic functions via console
- [ ] Check contract is accessible on BSCScan
- [ ] Document deployment addresses
- [ ] Update README with contract addresses (if needed)

---

## 🔒 Security Reminders

### Post-Deployment Security
1. **Never commit env.json** - It contains your mnemonic and API key
2. **Rotate API key** - The old key was exposed in git history
3. **Monitor contract** - Watch for unusual transactions
4. **Test thoroughly** - Before moving to mainnet

### Contract Security Features (v1.1.0)
- ✅ Comprehensive reentrancy protection
- ✅ Safe ownership transfer with events
- ✅ Multi-layer access control (onlyOwner, whenNotPaused)
- ✅ MEV protection and deadline checks
- ✅ Circuit breakers and emergency pause

---

## 📝 Deployment Record Template

After successful deployment, record these details:

```
Deployment Date: ___________
Network: BSC Testnet (Chain ID: 97)
Deployer Address: ___________
Gas Used: ___________
Total Cost (BNB): ___________

Contract Addresses:
- BofhContractV2: ___________
- [Other contracts as needed]

BSCScan Links:
- Contract: https://testnet.bscscan.com/address/___________
- Deployment TX: https://testnet.bscscan.com/tx/___________

Verification Status: [ ] Verified
Initial Owner: ___________
Base Token: ___________
```

---

## ⚠️ Known Issues

### Accepted for v1.1.0
1. **Testing Blocked**
   - Ganache incompatible with Node.js v25
   - Deferred to SPRINT 2 (Hardhat migration)
   - Contracts compile successfully

2. **npm Vulnerabilities**
   - 42 vulnerabilities in Truffle dependencies
   - Does not affect deployment
   - Will be resolved by Hardhat migration

---

## 🆘 Troubleshooting

### Common Issues

**Issue**: "Cannot find module './env.json'"
**Solution**: Create env.json from env.json.example

**Issue**: "Insufficient funds"
**Solution**: Get testnet BNB from https://testnet.binance.org/faucet-smart

**Issue**: "Network ID mismatch"
**Solution**: Verify truffle-config.js has network_id: 97

**Issue**: "Contract verification failed"
**Solution**: Ensure you're using the correct compiler version (0.8.10)

---

## 📞 Support Resources

- **Documentation**: See CLAUDE.md for development guidelines
- **Issues**: https://github.com/Bofh-Reloaded/BofhContract/issues
- **Release Notes**: RELEASE_NOTES_v1.1.0.md
- **BSC Testnet Faucet**: https://testnet.binance.org/faucet-smart
- **BSCScan Testnet**: https://testnet.bscscan.com

---

## ✅ Final Pre-Deployment Checklist

**Critical** (Must Complete):
- [ ] API key rotated
- [ ] env.json created and configured
- [ ] Dependencies installed
- [ ] Contracts compile successfully
- [ ] Deployment wallet has testnet BNB

**Recommended** (Should Complete):
- [ ] Run deployment dry-run
- [ ] Review gas estimates
- [ ] Prepare deployment record template
- [ ] Backup deployment wallet mnemonic

**Optional** (Nice to Have):
- [ ] Set up monitoring alerts
- [ ] Prepare integration tests
- [ ] Document API endpoints

---

**Ready to Deploy**: Once all critical items are checked, you're ready to deploy v1.1.0 to BSC Testnet!

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
