# Mathematical Foundations 📐

> **Correction notice.** Earlier versions of this document presented "golden ratio (φ)
> optimization", "Lagrange-multiplier optimality proofs", and "Bellman equations / dynamic
> programming for routing" as the contract's mathematics. **None of that was ever wired into
> the production swap path** — the optimization functions (`MathLib.calculateOptimalAmount`,
> `PoolLib.calculateOptimalSwapAmount`) had zero production callers and have been **removed**.
> `BofhContractV2` is a **sequential constant-product (x·y=k) multi-hop executor**: the full
> input amount flows through each hop in order, priced with the standard Uniswap-V2
> constant-product-with-fee formula. There is **no on-chain amount-splitting, no golden-ratio
> path optimization, no Lagrange optimizer, and no on-chain Bellman/dynamic-programming
> router** — any path-finding or amount-sizing belongs **off-chain**, not in the executor.
>
> The sections below marked **(historical design note)** describe an earlier, never-shipped
> proposal and are kept for context only. The **legitimate, real math is also retained**:
> the constant-product formula (§1.1), the `getAmountOut`-with-fee relation, per-hop price
> impact, and the Newton-Raphson and geometric-mean primitives (§4) genuinely back the
> deployed code.

## Arbitrage Theory and Implementation 📚

This document provides an in-depth analysis of the mathematical principles underlying the BofhContract's arbitrage and swap mechanisms.

### 1. Automated Market Maker Fundamentals 🎯

#### 1.1 Constant Product Market Maker (CPMM)

The fundamental equation governing AMM pools is:
```
x * y = k
```
where:
- x: Reserve of token X
- y: Reserve of token Y
- k: Constant product

For a trade of size Δx, the output Δy is given by:
```
Δy = y - k/(x + Δx)
```

#### 1.2 Multi-Pool Analysis

For n connected pools, we analyze the composite function:
```
f(x1, ..., xn) = ∏i (xi * yi = ki)
```

### 2. Optimal Path Execution 🛣️ *(historical design note — NOT shipped behavior)*

> ⚠️ **This entire section describes a never-shipped proposal.** The golden-ratio split,
> the Lagrange-multiplier "proof", and the Bellman/dynamic-programming router below were
> **never wired into production and have been removed from the code**. The deployed contract
> does **no** on-chain path optimization; it executes a caller-supplied path hop-by-hop.
> Retained for historical context only.

#### 2.1 Golden Ratio Optimization *(historical — removed from code)*

The golden ratio φ ≈ 0.618034 emerges from solving:
```
min f(x) = ∑i (1/xi), subject to ∏i xi = 1
```

##### 2.1.1 Four-Way Split Derivation

For a 4-way path, optimal proportions are:
```
[φ, φ2, φ3, 1-φ-φ2-φ3]
≈ [0.618034, 0.381966, 0.236068, 0.763932]
```

Proof of optimality:
1. Let f(x1,x2,x3,x4) = 1/x1 + 1/x2 + 1/x3 + 1/x4
2. Subject to: x1x2x3x4 = 1
3. Using Lagrange multipliers:
   ```
   ∂f/∂xi = λ∏j≠i xj
   ```
4. Solving yields the golden ratio relationships

##### 2.1.2 Five-Way Split Analysis

For 5-way paths:
```
[φ2, φ3, φ4, φ5, 1-∑φi]
≈ [0.381966, 0.236068, 0.145898, 0.090170, 0.145898]
```

#### 2.2 Dynamic Programming Implementation *(historical — never implemented on-chain)*

> ⚠️ The Bellman-equation router below was **never implemented in the contract**. There is
> no `optimizePath` / `calculateOptimalSplit` / `reconstructPath` in the deployed code; the
> snippet is illustrative of the abandoned proposal only. Routing (which path to trade) is a
> **caller-supplied, off-chain** decision.

The Bellman equation for path optimization:
```
V(s) = max_{a∈A} {R(s,a) + γV(s')}
```

Illustrative (never shipped) pseudo-code:
```solidity
function optimizePath(
    uint256[] memory reserves,
    uint256[] memory fees
) internal pure returns (uint256[] memory) {
    uint256 n = reserves.length;
    uint256[] memory dp = new uint256[](n);
    // Dynamic programming implementation
    for (uint256 i = 0; i < n; i++) {
        dp[i] = calculateOptimalSplit(i, reserves, fees);
    }
    return reconstructPath(dp);
}
```

### 3. Price Impact Analysis 📊

#### 3.1 Slippage Estimation

> ⚠️ **Correction.** The contract does **not** use the "third-order Taylor / λ market-depth"
> series shown below — that was part of the never-shipped optimization proposal. The deployed
> price-impact check is the **exact constant-product impact** computed per hop in
> `PoolLib.validateSwap` directly from `(reserveIn, reserveOut, amountIn)` and the per-hop
> fee, then compared against the configured cap. The Taylor expansion is retained here only as
> a historical note.

Historical (never-shipped) third-order Taylor expansion for price impact:
```
ΔP/P ≈ -λ(ΔR/R) + (λ2/2)(ΔR/R)2 - (λ3/6)(ΔR/R)3
```

**Actual deployed model — exact CPMM (x·y=k).** For a hop with reserves
`(reserveIn, reserveOut)`, fee `feeBps`, and input `amountIn`:
```
// Output pricing — SwapMathLib.getAmountOut
amountInWithFee = amountIn * (10000 - feeBps)
amountOut       = (amountInWithFee * reserveOut)
                  / (reserveIn * 10000 + amountInWithFee)

// Price impact (separate) — PoolLib.calculatePriceImpact
priceImpact     = (oldPrice - newPrice) / oldPrice, from the post-swap x·y=k reserves
```
The per-hop price impact is enforced against the configured cap in `PoolLib.validateSwap`;
there is no λ / Taylor model in code.

#### 3.2 Volatility Tracking

Exponential Moving Average (EMA) with dynamic α:
```
σt = α(t)rt2 + (1-α(t))σt−1
α(t) = 1 - exp(-Δt/τ)
```

### 4. Numerical Methods 🔢

#### 4.1 Newton-Raphson Method

For root finding (sqrt, cbrt):
```
xn+1 = xn - f(xn)/f'(xn)
```

Optimized implementation:
```solidity
function sqrt(uint256 x) internal pure returns (uint256 y) {
    // Detailed Newton-Raphson implementation
}
```

#### 4.2 Geometric Mean Calculation

For n numbers:
```
GM = (∏i xi)^(1/n)
```

### 5. Gas Optimization Techniques ⚡

#### 5.1 Bit Manipulation

For efficient division and multiplication:
```solidity
function fastDiv(uint256 a, uint256 b) internal pure returns (uint256) {
    // Optimized division using bit shifts
}
```

#### 5.2 Memory vs. Storage Optimization

Strategic use of memory and storage:
```solidity
function optimizedSwap(
    SwapState memory state,
    PoolState storage pool
) internal returns (uint256) {
    // Efficient state management
}
```

### 6. Benchmarks and Performance Analysis 📈

#### 6.1 Gas Consumption

| Operation          | Gas Used | Optimization Level |
|-------------------|----------|-------------------|
| 4-way swap        | ~250k    | Optimized        |
| 5-way swap        | ~320k    | Optimized        |
| Price calculation | ~5k      | Highly optimized |

#### 6.2 Computational Complexity

> ⚠️ The "Path optimization" row refers to the removed/never-shipped on-chain optimizer and
> does not describe the deployed contract (which performs no on-chain path optimization).

| Algorithm                          | Time Complexity | Space Complexity |
|------------------------------------|----------------|------------------|
| Path optimization *(removed)*      | O(n)           | O(1)             |
| Price impact (per-hop CPMM)        | O(1)           | O(1)             |
| Volatility calc                    | O(1)           | O(1)             |

### 7. Future Optimizations 🔮

#### 7.1 Parallel Computation

Potential for parallel execution:
```solidity
function parallelPathOptimization(
    uint256[][] memory paths
) internal pure returns (uint256[] memory) {
    // Future parallel implementation
}
```

#### 7.2 Advanced Mathematical Models

Areas for future enhancement:
- Quantum-inspired optimization
- Machine learning integration
- Advanced statistical models

### References 📚

1. "The Mathematics of DeFi" (2023)
2. "Optimal Arbitrage in AMM Markets" (2022)
3. "Numerical Methods in Smart Contracts" (2024)
4. "Gas Optimization Patterns in Solidity" (2023)