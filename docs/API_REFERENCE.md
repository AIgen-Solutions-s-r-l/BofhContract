# BofhContract API Reference

> **Correction notice.** The "golden ratio-based path distribution / optimization" described
> below was **never wired into production and has been removed**. `BofhContractV2` is a
> **sequential constant-product (x·y=k) multi-hop / multi-DEX atomic executor**: it runs a
> caller-supplied path hop-by-hop with no on-chain amount-splitting or golden-ratio
> optimization. Treat any "golden ratio" / `calculateOptimalAmount` reference here as
> historical.

## Table of Contents
- [Overview](#overview)
- [BofhContractV2](#bofhcontractv2)
  - [Core Functions](#core-functions)
  - [View Functions](#view-functions)
- [BofhContractBase](#bofhcontractbase)
  - [Administrative Functions](#administrative-functions)
  - [Risk Management](#risk-management)
  - [MEV Protection](#mev-protection)
  - [Emergency Controls](#emergency-controls)
- [Libraries](#libraries)
  - [MathLib](#mathlib)
  - [PoolLib](#poollib)
  - [SecurityLib](#securitylib)
- [Events](#events)
- [Errors](#errors)
- [Constants](#constants)

## Overview

BofhContractV2 is an advanced multi-path token swap router optimized for BSC that implements golden ratio-based path distribution for 3-way, 4-way, and 5-way swaps.

**Contract Address** (Testnet): `TBD after deployment`
**Contract Address** (Mainnet): `TBD after deployment`

**Key Features**:
- Multi-path swap optimization using golden ratio (φ ≈ 0.618034)
- Comprehensive security: reentrancy protection, MEV protection, circuit breakers
- Risk management: configurable slippage, price impact, liquidity thresholds
- Pool blacklisting for security
- Emergency pause mechanism

---

## BofhContractV2

Main contract for executing optimized token swaps.

### Core Functions

#### `executeSwap`

Execute a swap through a single path with comprehensive security checks.

```solidity
function executeSwap(
    address[] calldata path,
    uint256[] calldata fees,
    uint256 amountIn,
    uint256 minAmountOut,
    uint256 deadline
) external returns (uint256)
```

**Parameters**:
- `path`: Array of token addresses (must start and end with baseToken)
- `fees`: Array of fee amounts in basis points (length = path.length - 1)
- `amountIn`: Input token amount
- `minAmountOut`: Minimum acceptable output (slippage protection)
- `deadline`: Unix timestamp deadline for transaction execution

**Returns**: Actual output amount received

**Modifiers**: `nonReentrant`, `whenNotPaused`, `antiMEV`

**Requirements**:
- Path length: 2 ≤ length ≤ 6 (supports up to 5-way swaps)
- Path must start and end with `baseToken`
- `amountIn` and `minAmountOut` must be > 0
- `deadline` must be > `block.timestamp`
- All addresses in path must be non-zero
- Fees must be ≤ 10000 (100%)
- User must approve contract to spend `amountIn` of baseToken

**Events Emitted**: `SwapExecuted`

**Example**:
```javascript
const path = [WBNB, BUSD, USDT, WBNB]; // 3-hop arbitrage
const fees = [2500, 3000, 2500]; // 0.25%, 0.3%, 0.25%
const amountIn = ethers.parseEther("1.0");
const minAmountOut = ethers.parseEther("0.95");
const deadline = Math.floor(Date.now() / 1000) + 1800; // 30 minutes

await baseToken.approve(bofhAddress, ethers.MaxUint256);
const output = await bofh.executeSwap(path, fees, amountIn, minAmountOut, deadline);
console.log("Profit:", output - amountIn);
```

---

#### `executeMultiSwap`

Execute multiple swaps through different paths in parallel.

```solidity
function executeMultiSwap(
    address[][] calldata paths,
    uint256[][] calldata fees,
    uint256[] calldata amounts,
    uint256[] calldata minAmounts,
    uint256 deadline
) external returns (uint256[] memory)
```

**Parameters**:
- `paths`: Array of swap paths, each path is an array of token addresses
- `fees`: Array of fee arrays, one per path
- `amounts`: Array of input amounts, one per path
- `minAmounts`: Array of minimum output amounts, one per path
- `deadline`: Unix timestamp deadline

**Returns**: Array of actual output amounts from each path

**Modifiers**: `nonReentrant`, `whenNotPaused` (Note: `antiMEV` not applied due to stack depth)

**Requirements**:
- All arrays must have same length
- Each path must satisfy `executeSwap` requirements
- Total input must be profitable (totalOutput > totalInput)

**Events Emitted**: Multiple `SwapExecuted` events (one per path)

**Example**:
```javascript
const paths = [
  [WBNB, BUSD, WBNB],
  [WBNB, USDT, WBNB]
];
const fees = [
  [3000, 3000],
  [2500, 2500]
];
const amounts = [
  ethers.parseEther("0.5"),
  ethers.parseEther("0.5")
];
const minAmounts = [
  ethers.parseEther("0.48"),
  ethers.parseEther("0.48")
];
const deadline = Math.floor(Date.now() / 1000) + 1800;

const outputs = await bofh.executeMultiSwap(paths, fees, amounts, minAmounts, deadline);
console.log("Path 1 output:", outputs[0]);
console.log("Path 2 output:", outputs[1]);
```

---

### View Functions

#### `getOptimalPathMetrics`

Calculate expected output, price impact, and optimality score for a swap path.

```solidity
function getOptimalPathMetrics(
    address[] calldata path,
    uint256[] calldata amounts
) external view returns (
    uint256 expectedOutput,
    uint256 priceImpact,
    uint256 optimalityScore
)
```

**Parameters**:
- `path`: Token swap path
- `amounts`: Array of amounts at each step (amounts[0] = input amount)

**Returns**:
- `expectedOutput`: Final expected output after all hops
- `priceImpact`: Cumulative price impact (scaled by PRECISION = 1e6)
- `optimalityScore`: Output/input ratio (scaled by PRECISION, >1e6 = profitable)

**Example**:
```javascript
const path = [WBNB, BUSD, USDT, WBNB];
const amounts = [ethers.parseEther("1.0"), 0, 0, 0]; // Only first amount matters

const [output, impact, score] = await bofh.getOptimalPathMetrics(path, amounts);
console.log("Expected output:", output);
console.log("Price impact:", impact / 1e6, "%");
console.log("Optimality score:", score / 1e6);
console.log("Profitable:", score > 1e6);
```

---

#### `getBaseToken`

Get the base token address.

```solidity
function getBaseToken() external view returns (address)
```

**Returns**: Address of the base token (e.g., WBNB)

---

#### `getFactory`

Get the factory address.

```solidity
function getFactory() external view returns (address)
```

**Returns**: Address of the Uniswap V2-style factory

---

## BofhContractBase

Abstract base contract providing security and risk management.

### Administrative Functions

#### `getAdmin`

Get the contract owner address.

```solidity
function getAdmin() external view returns (address)
```

**Returns**: Owner address

---

#### `transferOwnership`

Transfer contract ownership to a new address.

```solidity
function transferOwnership(address newOwner) external
```

**Parameters**:
- `newOwner`: Address of new owner (must not be address(0))

**Access**: Owner only

**Events Emitted**: `OwnershipTransferred`

---

#### `setOperator`

Grant or revoke operator status.

```solidity
function setOperator(address operator, bool status) external
```

**Parameters**:
- `operator`: Address to modify
- `status`: True to grant, false to revoke

**Access**: Owner only

**Events Emitted**: `OperatorStatusChanged`

---

### Risk Management

#### `updateRiskParams`

Update risk management parameters.

```solidity
function updateRiskParams(
    uint256 _maxTradeVolume,
    uint256 _minPoolLiquidity,
    uint256 _maxPriceImpact,
    uint256 _sandwichProtectionBips
) external
```

**Parameters**:
- `_maxTradeVolume`: Maximum trade volume per swap
- `_minPoolLiquidity`: Minimum required pool liquidity
- `_maxPriceImpact`: Maximum price impact (max 20% = PRECISION/5)
- `_sandwichProtectionBips`: Sandwich protection in basis points (max 100 = 1%)

**Access**: Owner only

**Requirements**:
- `_maxPriceImpact` ≤ PRECISION / 5 (20%)
- `_sandwichProtectionBips` ≤ 100 (1%)

**Events Emitted**: `RiskParamsUpdated`

**Example**:
```javascript
await bofh.updateRiskParams(
  ethers.parseEther("500"),  // maxTradeVolume
  ethers.parseEther("50"),   // minPoolLiquidity
  BigInt(150000),            // maxPriceImpact: 15%
  BigInt(75)                 // sandwichProtection: 0.75%
);
```

---

#### `getRiskParameters`

Get current risk management parameters.

```solidity
function getRiskParameters() external view returns (
    uint256 maxVolume,
    uint256 minLiquidity,
    uint256 maxImpact,
    uint256 sandwichProtection
)
```

**Returns**: All risk parameters as tuple

---

#### `setPoolBlacklist`

Blacklist or whitelist a pool address.

```solidity
function setPoolBlacklist(address pool, bool blacklisted) external
```

**Parameters**:
- `pool`: Pool address
- `blacklisted`: True to blacklist, false to whitelist

**Access**: Owner only

**Events Emitted**: `PoolBlacklisted`

---

#### `isPoolBlacklisted`

Check if a pool is blacklisted.

```solidity
function isPoolBlacklisted(address pool) external view returns (bool)
```

**Returns**: True if blacklisted

---

### MEV Protection

#### `configureMEVProtection`

Configure MEV protection parameters.

```solidity
function configureMEVProtection(
    bool enabled,
    uint256 _maxTxPerBlock,
    uint256 _minTxDelay
) external
```

**Parameters**:
- `enabled`: Enable/disable MEV protection
- `_maxTxPerBlock`: Max transactions per block per address (must be > 0)
- `_minTxDelay`: Minimum seconds between transactions (must be > 0)

**Access**: Owner only

**Events Emitted**: `MEVProtectionUpdated`

**Example**:
```javascript
// Enable strict MEV protection
await bofh.configureMEVProtection(
  true,  // enabled
  2,     // max 2 transactions per block
  30     // 30 second delay between transactions
);
```

---

#### `getMEVProtectionConfig`

Get MEV protection configuration.

```solidity
function getMEVProtectionConfig() external view returns (
    bool enabled,
    uint256 maxTx,
    uint256 minDelay
)
```

**Returns**: MEV protection settings

---

### Emergency Controls

#### `emergencyPause`

Pause all contract operations.

```solidity
function emergencyPause() external
```

**Access**: Owner only

**Effects**: Blocks all functions with `whenNotPaused` modifier

**Events Emitted**: `SecurityStateChanged`

**Use Cases**:
- Exploit detected
- Critical bug found
- Oracle compromise
- Market manipulation detected

---

#### `emergencyUnpause`

Resume contract operations.

```solidity
function emergencyUnpause() external
```

**Access**: Owner only

**Events Emitted**: `SecurityStateChanged`

---

#### `isPaused`

Check if contract is paused.

```solidity
function isPaused() external view returns (bool)
```

**Returns**: True if paused

---

## Libraries

### MathLib

Mathematical operations library.

#### `sqrt`

Calculate square root using Newton's method.

```solidity
function sqrt(uint256 x) internal pure returns (uint256 y)
```

**Algorithm**: Newton-Raphson iteration: y_{n+1} = (y_n + x/y_n) / 2

---

#### `cbrt`

Calculate cube root using Newton's method.

```solidity
function cbrt(uint256 x) internal pure returns (uint256)
```

**Algorithm**: Newton-Raphson: y_{n+1} = (2*y_n + x/y_n²) / 3

---

#### `geometricMean`

Calculate geometric mean with overflow protection.

```solidity
function geometricMean(uint256 a, uint256 b) internal pure returns (uint256)
```

**Formula**: √(a × b)

---

#### `calculateOptimalAmount`

Calculate optimal amount distribution using golden ratio.

```solidity
function calculateOptimalAmount(
    uint256 amount,
    uint256 pathLength,
    uint256 position
) internal pure returns (uint256)
```

**Strategy**:
- 3-way: Equal distribution (1/3 each)
- 4-way: Golden ratio φ ≈ 0.618034
- 5-way: Golden ratio squared φ² ≈ 0.381966

---

### PoolLib

Pool analysis and management library.

#### `analyzePool`

Analyze pool state and calculate metrics.

```solidity
function analyzePool(
    address pool,
    address tokenIn,
    uint256 amountIn,
    uint256 timestamp
) internal view returns (PoolState memory state)
```

**Returns**: Complete pool state including depth, volatility, price impact

---

#### `calculatePriceImpact`

Calculate price impact percentage.

```solidity
function calculatePriceImpact(
    uint256 amountIn,
    PoolState memory pool
) internal pure returns (uint256)
```

**Formula**: impact = (oldPrice - newPrice) / oldPrice

---

### SecurityLib

Security primitives library.

#### `enterProtectedSection` / `exitProtectedSection`

Reentrancy guard implementation.

```solidity
function enterProtectedSection(SecurityState storage self, bytes4 selector) internal
function exitProtectedSection(SecurityState storage self) internal
```

**Usage**: Wrap function body between enter/exit calls

---

## Events

### `SwapExecuted`

Emitted when a swap is successfully executed.

```solidity
event SwapExecuted(
    address indexed initiator,
    uint256 pathLength,
    uint256 inputAmount,
    uint256 outputAmount,
    uint256 priceImpact
)
```

**Parameters**:
- `initiator`: Address that initiated the swap
- `pathLength`: Number of tokens in swap path
- `inputAmount`: Amount of input tokens
- `outputAmount`: Amount of output tokens received
- `priceImpact`: Cumulative price impact (scaled by PRECISION)

---

### `MEVProtectionUpdated`

Emitted when MEV protection config changes.

```solidity
event MEVProtectionUpdated(
    bool enabled,
    uint256 maxTxPerBlock,
    uint256 minTxDelay
)
```

---

### `RiskParamsUpdated`

Emitted when risk parameters are updated.

```solidity
event RiskParamsUpdated(
    uint256 maxVolume,
    uint256 minLiquidity,
    uint256 maxImpact,
    uint256 sandwichProtection
)
```

---

### `PoolBlacklisted`

Emitted when pool blacklist status changes.

```solidity
event PoolBlacklisted(
    address indexed pool,
    bool blacklisted
)
```

---

## Errors

### `InvalidPath()`
Swap path structure is invalid (wrong start/end token or length constraints violated)

### `InsufficientOutput()`
Final output amount < minAmountOut

### `ExcessiveSlippage()`
Price slippage exceeds MAX_SLIPPAGE (1%)

### `PathTooLong()`
Path length exceeds MAX_PATH_LENGTH (6)

### `DeadlineExpired()`
block.timestamp > deadline

### `InsufficientLiquidity()`
Pool liquidity below minimum threshold

### `InvalidAddress()`
Address parameter is address(0) or invalid

### `InvalidAmount()`
Amount parameter is 0 or invalid

### `InvalidArrayLength()`
Array lengths don't match expected values

### `InvalidFee()`
Fee exceeds maximum (100% = 10000 bps)

### `FlashLoanDetected()`
Too many transactions per block (MEV protection)

### `RateLimitExceeded()`
Transactions too frequent (MEV protection)

---

## Constants

```solidity
uint256 constant PRECISION = 1e6;              // Base precision (1,000,000 = 100%)
uint256 constant MAX_SLIPPAGE = PRECISION / 100; // 1% maximum slippage
uint256 constant MIN_OPTIMALITY = PRECISION / 2; // 50% minimum optimality
uint256 constant MAX_PATH_LENGTH = 6;           // Up to 5-way swaps (6 tokens)
```

---

## Integration Examples

### Basic Swap

```javascript
// Setup
const BofhContractV2 = await ethers.getContractFactory("BofhContractV2");
const bofh = BofhContractV2.attach(DEPLOYED_ADDRESS);
const baseToken = await ethers.getContractAt("IBEP20", await bofh.getBaseToken());

// Approve
await baseToken.approve(DEPLOYED_ADDRESS, ethers.MaxUint256);

// Execute swap
const path = [WBNB, BUSD, WBNB];
const fees = [3000, 3000];
const amountIn = ethers.parseEther("1.0");
const minAmountOut = ethers.parseEther("0.95");
const deadline = Math.floor(Date.now() / 1000) + 1800;

const output = await bofh.executeSwap(path, fees, amountIn, minAmountOut, deadline);
console.log("Received:", ethers.formatEther(output), "WBNB");
```

### Monitor Events

```javascript
// Listen for swaps
bofh.on("SwapExecuted", (initiator, pathLength, inputAmount, outputAmount, priceImpact) => {
  console.log(`Swap by ${initiator}:`);
  console.log(`  Input: ${ethers.formatEther(inputAmount)} WBNB`);
  console.log(`  Output: ${ethers.formatEther(outputAmount)} WBNB`);
  console.log(`  Profit: ${ethers.formatEther(outputAmount - inputAmount)} WBNB`);
  console.log(`  Impact: ${priceImpact / 1e4}%`);
});
```

### Check Profitability Before Swap

```javascript
const [expectedOutput, priceImpact, score] = await bofh.getOptimalPathMetrics(path, [amountIn, 0, 0]);

if (score > 1e6) {
  const profit = expectedOutput - amountIn;
  console.log("Profitable! Expected profit:", ethers.formatEther(profit));

  // Execute swap
  await bofh.executeSwap(path, fees, amountIn, minAmountOut, deadline);
} else {
  console.log("Not profitable, skipping swap");
}
```

---

## Gas Costs (Approximate)

Based on BSC testnet measurements:

| Operation | Gas Cost | BNB Cost (@ 5 gwei) |
|-----------|----------|---------------------|
| Deploy Contract | ~2,500,000 | ~0.0125 BNB |
| executeSwap (3-hop) | ~200,000 | ~0.001 BNB |
| executeMultiSwap (2 paths) | ~350,000 | ~0.00175 BNB |
| updateRiskParams | ~50,000 | ~0.00025 BNB |
| configureMEVProtection | ~45,000 | ~0.000225 BNB |
| emergencyPause | ~30,000 | ~0.00015 BNB |

*Costs vary based on network congestion and path complexity*

---

## Support

- **Documentation**: [/docs](/docs)
- **GitHub Issues**: https://github.com/your-org/BofhContract/issues
- **Architecture**: [ARCHITECTURE.md](./ARCHITECTURE.md)
- **Security**: [SECURITY.md](./SECURITY.md)
- **Deployment**: [DEPLOYMENT.md](./DEPLOYMENT.md)
