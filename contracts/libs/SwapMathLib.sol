// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.10;

import "../interfaces/ISwapInterfaces.sol";
import "../interfaces/IBofhContract.sol";
import "./PoolLib.sol";

/// @title SwapMathLib - Shared CPMM pricing, fee-aware path simulation, and safe-transfer helpers
/// @author Bofh Team
/// @notice Internal library extracted from BofhContractV2 to share ONE implementation of the
/// @notice constant-product-with-fee pricing between the swap hot path and the off-chain views,
/// @notice and to host the fee-aware path-simulation helpers and the assembly safe-transfer helpers.
/// @dev ALL functions are `internal` so the compiler inlines them into BofhContractV2 — identical
/// @dev bytecode, identical gas, no DELEGATECALL boundary. No contract storage is read; the factory
/// @dev address and path/fees/amounts are passed in explicitly. PRECISION (1e6) and MAX_FEE_BPS (1000)
/// @dev are re-declared with byte-identical literals so view results match BofhContractBase/DexRegistry.
/// @custom:security Custom errors (InvalidFee, PairDoesNotExist) are referenced via IBofhContract so
/// @custom:security revert selectors are unchanged from the in-contract implementation.
library SwapMathLib {
    /// @notice Base precision for calculations (1,000,000) — identical to BofhContractBase.PRECISION
    uint256 internal constant PRECISION = 1e6;

    /// @notice Maximum per-hop fee in basis points (1000 = 10%) — identical to DexRegistry.MAX_FEE_BPS
    uint256 internal constant MAX_FEE_BPS = 1000;

    /// @notice In-memory simulated reserve record for a pair, used ONLY by the fee-aware views
    /// @dev Lets getOptimalPathMetrics(fees) reflect intra-path reserve changes when a path revisits
    /// @dev the same pool (e.g. BASE->A->BASE), so the view matches realized execution to the wei.
    /// @dev Reserves are stored CANONICALLY in token0/token1 orientation (not per-hop tokenIn) so any
    /// @dev later hop reads them correctly regardless of direction.
    /// @custom:field pair Pair contract address (zero = empty slot)
    /// @custom:field reserve0 Simulated reserve of token0
    /// @custom:field reserve1 Simulated reserve of token1
    struct SimReserve {
        address pair;
        uint256 reserve0;
        uint256 reserve1;
    }

    /// @notice Sentinel fee value meaning "use the resolved DEX's registry fee" for a hop
    /// @dev Identical literal to BofhContractV2.USE_REGISTRY_FEE so the multi-DEX validation path
    /// @dev exempts the sentinel from the MAX_FEE_BPS cap exactly as before.
    uint256 internal constant USE_REGISTRY_FEE = type(uint256).max;

    /// @notice Validate all swap parameters before execution (shared by single-DEX and multi-DEX paths)
    /// @dev Comprehensive validation: deadline, array lengths, amounts, addresses, path structure, fees.
    /// @dev Behavior is byte-identical to the previous in-contract _validateSwapInputs /
    /// @dev _validateSwapInputsMultiDex: the ONLY difference is the fee step, gated by allowRegistrySentinel.
    /// @param baseToken Base token that every path must start and end with (passed in; reads no storage)
    /// @param maxPathLength Maximum allowed path length (MAX_PATH_LENGTH = 6)
    /// @param path Token swap path (must start and end with baseToken)
    /// @param fees Fee array in basis points (length = path.length - 1)
    /// @param amountIn Input amount (must be > 0)
    /// @param minAmountOut Minimum output amount (must be > 0)
    /// @param deadline Transaction deadline Unix timestamp (must be > block.timestamp)
    /// @param allowRegistrySentinel When true, a fees[i] == USE_REGISTRY_FEE is permitted (multi-DEX
    /// @param allowRegistrySentinel path); a concrete fee is still capped at MAX_FEE_BPS either way.
    /// @return pathLength Length of the path for gas-optimized loops
    function validateSwapInputs(
        address baseToken,
        uint256 maxPathLength,
        address[] calldata path,
        uint256[] calldata fees,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline,
        bool allowRegistrySentinel
    ) internal view returns (uint256 pathLength) {
        // 1. Deadline validation
        if (deadline == 0) revert IBofhContract.InvalidAmount();
        if (block.timestamp > deadline) revert IBofhContract.DeadlineExpired();

        // 2. Array length validation
        pathLength = path.length;
        if (pathLength == 0) revert IBofhContract.InvalidArrayLength();
        if (pathLength < 2 || pathLength > maxPathLength) revert IBofhContract.InvalidPath();
        if (pathLength != fees.length + 1) revert IBofhContract.InvalidArrayLength();

        // 3. Amount validation
        if (amountIn == 0) revert IBofhContract.InvalidAmount();
        if (minAmountOut == 0) revert IBofhContract.InvalidAmount();

        // 4. Path address validation
        for (uint256 i = 0; i < pathLength;) {
            if (path[i] == address(0)) revert IBofhContract.InvalidAddress();
            unchecked { ++i; }
        }

        // 5. Path structure validation
        if (path[0] != baseToken || path[pathLength - 1] != baseToken) revert IBofhContract.InvalidPath();

        // 6. Fee validation: concrete fees capped at MAX_FEE_BPS; the registry-fee sentinel is allowed
        //    only on the multi-DEX path (allowRegistrySentinel == true).
        if (allowRegistrySentinel) {
            for (uint256 i = 0; i < fees.length;) {
                if (fees[i] != USE_REGISTRY_FEE && fees[i] > MAX_FEE_BPS) revert IBofhContract.InvalidFee();
                unchecked { ++i; }
            }
        } else {
            for (uint256 i = 0; i < fees.length;) {
                if (fees[i] > MAX_FEE_BPS) revert IBofhContract.InvalidFee();
                unchecked { ++i; }
            }
        }
    }

    /// @notice Constant-product-with-fee output (the single shared CPMM pricing formula)
    /// @dev Operation order is preserved EXACTLY: amountInWithFee = amountIn*(10000-feeBps) first,
    /// @dev numerator = amountInWithFee*reserveOut, denominator = reserveIn*10000 + amountInWithFee,
    /// @dev then a single integer division. Uses CHECKED arithmetic: for all real inputs (uint112
    /// @dev reserves, validated feeBps <= MAX_FEE_BPS) the result is identical to the legacy path,
    /// @dev and a pathological overflow reverts rather than silently wrapping (the FoT/multi-DEX
    /// @dev branch was already checked; this keeps every path checked). Callers ensure feeBps <= 10000.
    /// @param amountIn Input amount for this hop
    /// @param reserveIn Input token reserve
    /// @param reserveOut Output token reserve
    /// @param feeBps Per-hop fee in basis points out of 10000 (e.g. 30 = 0.3%)
    /// @return Output amount after the fee
    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 feeBps
    ) internal pure returns (uint256) {
        uint256 amountInWithFee = amountIn * (10000 - feeBps);
        return (amountInWithFee * reserveOut) / (reserveIn * 10000 + amountInWithFee);
    }

    /// @notice Price impact for a hop, matching PoolLib._calculatePriceImpactInline exactly
    /// @param amountIn Input amount
    /// @param reserveIn Input token reserve
    /// @param reserveOut Output token reserve
    /// @return Price impact scaled by PRECISION
    function priceImpact(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        if (amountIn == 0) return 0;
        uint256 newReserveIn = reserveIn + amountIn;
        uint256 newReserveOut = (reserveIn * reserveOut) / newReserveIn;
        uint256 oldPrice = (reserveOut * PRECISION) / reserveIn;
        uint256 newPrice = (newReserveOut * PRECISION) / newReserveIn;
        if (newPrice >= oldPrice) return 0;
        return ((oldPrice - newPrice) * PRECISION) / oldPrice;
    }

    /// @notice Resolve a pair from a V2-style factory, reverting PairDoesNotExist on a zero result
    /// @dev Mirrors BofhContractV2._getPairFrom so view pair-resolution is byte-identical.
    /// @param pairFactory Uniswap-V2-style factory to query
    /// @param tokenA First token address
    /// @param tokenB Second token address
    /// @return pair The pair contract address
    function getPairFrom(address pairFactory, address tokenA, address tokenB) internal view returns (address pair) {
        pair = IFactory(pairFactory).getPair(tokenA, tokenB);
        if (pair == address(0)) revert IBofhContract.PairDoesNotExist();
    }

    /// @notice Execute a single swap hop (pre-fund -> IGenericPair.swap -> balanceOf delta)
    /// @dev Moved verbatim from BofhContractV2.executePathStep so the per-hop mechanics live in one
    /// @dev place. `internal` => inlined into the contract: identical bytecode, gas, and token-flow
    /// @dev order. Operates on plain scalars (not the contract's SwapState struct) so the struct stays
    /// @dev in the contract; the caller assigns currentToken = tokenOut after this returns.
    /// @param pairFactory Factory to resolve the pair for this hop
    /// @param tokenIn Input token for this hop
    /// @param tokenOut Output token for this hop
    /// @param feeBps Per-hop fee in basis points (caller-validated; re-checked here for defense-in-depth)
    /// @param amountIn Current input amount for this hop
    /// @param cumulativeImpact Running cumulative price impact (in)
    /// @param maxPriceImpactParam Pool-validation max price impact (BofhContractBase.maxPriceImpact)
    /// @param maxSlippageParam Max slippage for pool validation (BofhContractBase.MAX_SLIPPAGE)
    /// @param fotSafe When false uses the legacy pre-fund order; when true sizes output on the amount
    /// @param fotSafe the PAIR actually receives (FoT-safe). For non-FoT tokens both are identical.
    /// @return amountOut Output amount produced by this hop (balanceOf delta)
    /// @return newCumulativeImpact Updated cumulative price impact
    function executeHop(
        address pairFactory,
        address tokenIn,
        address tokenOut,
        uint256 feeBps,
        uint256 amountIn,
        uint256 cumulativeImpact,
        uint256 maxPriceImpactParam,
        uint256 maxSlippageParam,
        bool fotSafe
    ) internal returns (uint256 amountOut, uint256 newCumulativeImpact) {
        // Defense-in-depth: the pricing computes (10000 - feeBps). Callers reach this helper only via
        // validated entrypoints (fees[i] <= MAX_FEE_BPS), but re-check so the subtraction can never
        // underflow if a future caller forgets.
        if (feeBps > MAX_FEE_BPS) revert IBofhContract.InvalidFee();

        // Get the pair address for these two tokens from the supplied factory (DEX-specific)
        address pairAddress = getPairFrom(pairFactory, tokenIn, tokenOut);

        // Analyze pool state using the pair address
        PoolLib.PoolState memory pool = PoolLib.analyzePool(
            pairAddress,
            tokenIn,
            amountIn,
            block.timestamp
        );

        // Validate pool state (params struct scoped so it does not stay live -> avoids "stack too deep")
        if (!PoolLib.validateSwap(pool, PoolLib.SwapParams({
            amountIn: amountIn,
            minAmountOut: 0, // Calculated dynamically
            maxPriceImpact: maxPriceImpactParam,
            deadline: block.timestamp + 1, // Immediate execution
            maxSlippage: maxSlippageParam
        }))) revert IBofhContract.InvalidSwapParameters();

        // Add price impact (keep in Solidity for struct access simplicity)
        unchecked {
            newCumulativeImpact = cumulativeImpact + pool.priceImpact;
        }

        // Pricing + pre-fund + swap + balanceOf-delta sizing is in a sub-call so the validation-only
        // scalars (factory/maxImpact/maxSlippage/cumulativeImpact) do not co-exist on the stack with the
        // swap locals -> avoids "stack too deep". Behavior/token-flow order is byte-identical.
        amountOut = _swapOnPair(pairAddress, tokenIn, tokenOut, feeBps, amountIn, pool, fotSafe);
    }

    /// @notice Price one hop and perform the pre-fund -> IGenericPair.swap -> balanceOf-delta swap
    /// @dev Extracted from executeHop ONLY to bound stack depth; the legacy/FoT branches are verbatim.
    /// @param pairAddress Resolved pair for this hop
    /// @param tokenIn Input token
    /// @param tokenOut Output token
    /// @param feeBps Per-hop fee in basis points
    /// @param amountIn Input amount for this hop
    /// @param pool Analyzed pool state (reserves + orientation)
    /// @param fotSafe When true size the output on the amount the PAIR actually receives (FoT-safe)
    /// @return amountOut Output amount produced by this hop (balanceOf delta)
    function _swapOnPair(
        address pairAddress,
        address tokenIn,
        address tokenOut,
        uint256 feeBps,
        uint256 amountIn,
        PoolLib.PoolState memory pool,
        bool fotSafe
    ) private returns (uint256 amountOut) {
        if (fotSafe) {
            // FoT-safe: transfer first, size output on the amount the PAIR actually received.
            // Works for fee-on-transfer tokens at any hop; for normal tokens received == sent.
            uint256 pairInBefore = IBEP20(tokenIn).balanceOf(pairAddress);
            safeTransfer(tokenIn, pairAddress, amountIn);
            uint256 pairReceived = IBEP20(tokenIn).balanceOf(pairAddress) - pairInBefore;

            // Single shared CPMM-with-fee formula/operation-order (same as the legacy branch below).
            uint256 expectedOutput =
                getAmountOut(pairReceived, pool.reserveIn, pool.reserveOut, feeBps);

            uint256 balanceBefore = IBEP20(tokenOut).balanceOf(address(this));
            IGenericPair(pairAddress).swap(
                pool.sellingToken0 ? 0 : expectedOutput,
                pool.sellingToken0 ? expectedOutput : 0,
                address(this),
                new bytes(0)
            );
            return IBEP20(tokenOut).balanceOf(address(this)) - balanceBefore;
        }

        // Legacy path (byte-identical): same single shared CPMM-with-fee formula, then pre-fund + swap.
        // amountOut = (amountIn * reserveOut * (10000 - feeBps)) /
        //             (reserveIn * 10000 + amountIn * (10000 - feeBps))
        uint256 legacyExpectedOutput =
            getAmountOut(amountIn, pool.reserveIn, pool.reserveOut, feeBps);

        // Transfer tokens to the pair contract (Uniswap V2 pattern)
        safeTransfer(tokenIn, pairAddress, amountIn);

        uint256 balBefore = IBEP20(tokenOut).balanceOf(address(this));
        IGenericPair(pairAddress).swap(
            pool.sellingToken0 ? 0 : legacyExpectedOutput,
            pool.sellingToken0 ? legacyExpectedOutput : 0,
            address(this),
            new bytes(0)
        );
        amountOut = IBEP20(tokenOut).balanceOf(address(this)) - balBefore;
    }

    /// @notice Find a pair's index in the tracked sims array
    /// @param pairAddress Pair to look up
    /// @param sims Tracked pair states
    /// @param simCount Populated entries in sims
    /// @return idx Index of the pair (valid only when found)
    /// @return found True if the pair is already tracked
    function findSim(
        address pairAddress,
        SimReserve[] memory sims,
        uint256 simCount
    ) internal pure returns (uint256 idx, bool found) {
        for (uint256 j = 0; j < simCount;) {
            if (sims[j].pair == pairAddress) return (j, true);
            unchecked { ++j; }
        }
        return (0, false);
    }

    /// @notice Read a pair's live reserves in canonical token0/token1 orientation
    /// @param pairAddress Pair to read
    /// @return reserve0 Reserve of token0
    /// @return reserve1 Reserve of token1
    function liveReserves(address pairAddress) internal view returns (uint256 reserve0, uint256 reserve1) {
        (reserve0, reserve1, ) = IGenericPair(pairAddress).getReserves();
    }

    /// @notice Price one simulated hop, tracking the pool's reserves so revisits match exec
    /// @dev On first encounter of a pair, seeds simulated reserves from live reserves (oriented to
    /// @dev this hop's tokenIn). Computes amountOut with the same operation order as executePathStep,
    /// @dev accumulates price impact on the pre-hop reserves, then updates the simulated reserves.
    /// @param pairAddress Resolved pair for this hop
    /// @param tokenIn Input token for this hop
    /// @param amountIn Input amount for this hop
    /// @param feeBps Per-hop fee in basis points
    /// @param cumulativeImpact Running cumulative price impact
    /// @param sims Memory array of tracked pair reserve states
    /// @param simCount Number of populated entries in sims
    /// @return amountOut Output amount for this hop
    /// @return newCumulativeImpact Updated cumulative price impact
    /// @return newSimCount Updated number of populated sims entries
    function simHop(
        address pairAddress,
        address tokenIn,
        uint256 amountIn,
        uint256 feeBps,
        uint256 cumulativeImpact,
        SimReserve[] memory sims,
        uint256 simCount
    ) internal view returns (uint256 amountOut, uint256 newCumulativeImpact, uint256 newSimCount) {
        // Locate (or seed) this pair's simulated reserves in canonical token0/token1 orientation.
        (uint256 idx, bool found) = findSim(pairAddress, sims, simCount);
        newSimCount = simCount;
        if (!found) {
            // First encounter: read live reserves canonically (token0/token1).
            (uint256 r0, uint256 r1) = liveReserves(pairAddress);
            idx = simCount;
            sims[idx] = SimReserve({pair: pairAddress, reserve0: r0, reserve1: r1});
            unchecked { newSimCount = simCount + 1; }
        }

        // Orient to this hop's input token.
        bool inIsToken0 = (tokenIn == IGenericPair(pairAddress).token0());
        uint256 reserveIn = inIsToken0 ? sims[idx].reserve0 : sims[idx].reserve1;
        uint256 reserveOut = inIsToken0 ? sims[idx].reserve1 : sims[idx].reserve0;

        // Price impact on pre-hop reserves (matches PoolLib._calculatePriceImpactInline math).
        unchecked {
            newCumulativeImpact = cumulativeImpact + priceImpact(amountIn, reserveIn, reserveOut);
        }

        // Same formula/operation-order as executePathStep so view == realized exec.
        amountOut = getAmountOut(amountIn, reserveIn, reserveOut, feeBps);

        // Update simulated reserves (canonical orientation) for any later revisit on the path.
        if (inIsToken0) {
            sims[idx].reserve0 = reserveIn + amountIn;
            sims[idx].reserve1 = reserveOut - amountOut;
        } else {
            sims[idx].reserve1 = reserveIn + amountIn;
            sims[idx].reserve0 = reserveOut - amountOut;
        }
    }

    /// @notice Simulate a single-DEX path (all hops via the immutable factory) with reserve tracking
    /// @dev Mirrors realized execution EXACTLY: prices each hop with the CPMM-with-fee formula and
    /// @dev updates the pool's simulated reserves, so revisited pools (e.g. BASE->A->BASE) match exec.
    /// @param factory Immutable factory to resolve every hop's pair
    /// @param path Token path
    /// @param fees Per-hop fees in basis points (each validated <= MAX_FEE_BPS here)
    /// @param amountIn Initial input amount
    /// @return expectedOutput Final output after all hops
    /// @return cumulativeImpact Accumulated price impact across hops
    function simulatePath(
        address factory,
        address[] calldata path,
        uint256[] calldata fees,
        uint256 amountIn
    ) internal view returns (uint256 expectedOutput, uint256 cumulativeImpact) {
        uint256 hops = path.length - 1;
        SimReserve[] memory sims = new SimReserve[](hops);
        uint256 simCount;
        expectedOutput = amountIn;

        for (uint256 i = 0; i < hops;) {
            if (fees[i] > MAX_FEE_BPS) revert IBofhContract.InvalidFee();
            (expectedOutput, cumulativeImpact, simCount) = simHop(
                getPairFrom(factory, path[i], path[i + 1]),
                path[i],
                expectedOutput,
                fees[i],
                cumulativeImpact,
                sims,
                simCount
            );
            unchecked { ++i; }
        }
    }

    /// @notice Simulate a multi-DEX path (per-hop factories) with reserve tracking
    /// @dev Same reserve-tracking simulation as simulatePath but each hop uses factories[i].
    /// @param path Token path
    /// @param factories Per-hop resolved factory addresses
    /// @param hopFees Per-hop effective fees in basis points
    /// @param amountIn Initial input amount
    /// @return expectedOutput Final output after all hops
    /// @return cumulativeImpact Accumulated price impact across hops
    function simulatePathMultiDex(
        address[] calldata path,
        address[] memory factories,
        uint256[] memory hopFees,
        uint256 amountIn
    ) internal view returns (uint256 expectedOutput, uint256 cumulativeImpact) {
        uint256 hops = path.length - 1;
        SimReserve[] memory sims = new SimReserve[](hops);
        uint256 simCount;
        expectedOutput = amountIn;

        for (uint256 i = 0; i < hops;) {
            (expectedOutput, cumulativeImpact, simCount) = simHop(
                getPairFrom(factories[i], path[i], path[i + 1]),
                path[i],
                expectedOutput,
                hopFees[i],
                cumulativeImpact,
                sims,
                simCount
            );
            unchecked { ++i; }
        }
    }

    /// @notice Safe token transferFrom using low-level call for gas optimization
    /// @dev Assembly-based transferFrom with proper error handling. The TransferFailed() selector
    /// @dev (0x90b8ec18) is hard-coded in the assembly, so this does not depend on error import.
    /// @param token Token address to transfer from
    /// @param from Address to transfer from
    /// @param to Recipient address
    /// @param amount Amount to transfer
    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        assembly {
            // Get free memory pointer
            let ptr := mload(0x40)

            // Store transferFrom(address,address,uint256) selector: 0x23b872dd
            mstore(ptr, 0x23b872dd00000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x04), from)
            mstore(add(ptr, 0x24), to)
            mstore(add(ptr, 0x44), amount)

            // Call transferFrom function
            let success := call(
                gas(),      // Forward all gas
                token,      // Token address
                0,          // No ETH value
                ptr,        // Input data pointer
                0x64,       // Input size: 4 (selector) + 32 (from) + 32 (to) + 32 (amount)
                ptr,        // Output pointer (reuse input)
                0x20        // Output size: 32 bytes (bool)
            )

            // Check if call succeeded and returned true
            switch returndatasize()
            case 0 {
                // No return data
                if iszero(success) {
                    // Revert with TransferFailed()
                    mstore(ptr, 0x90b8ec1800000000000000000000000000000000000000000000000000000000)
                    revert(ptr, 0x04)
                }
            }
            default {
                // Token returned data - check if it's true
                let returnValue := mload(ptr)
                if or(iszero(success), iszero(returnValue)) {
                    // Revert with TransferFailed()
                    mstore(ptr, 0x90b8ec1800000000000000000000000000000000000000000000000000000000)
                    revert(ptr, 0x04)
                }
            }
        }
    }

    /// @notice Safe token transfer using low-level call for gas optimization
    /// @dev Assembly-based transfer with proper error handling. The TransferFailed() selector
    /// @dev (0x90b8ec18) is hard-coded in the assembly, so this does not depend on error import.
    /// @param token Token address to transfer
    /// @param to Recipient address
    /// @param amount Amount to transfer
    function safeTransfer(address token, address to, uint256 amount) internal {
        assembly {
            // Get free memory pointer
            let ptr := mload(0x40)

            // Store transfer(address,uint256) selector: 0xa9059cbb
            mstore(ptr, 0xa9059cbb00000000000000000000000000000000000000000000000000000000)
            mstore(add(ptr, 0x04), to)
            mstore(add(ptr, 0x24), amount)

            // Call transfer function
            let success := call(
                gas(),      // Forward all gas
                token,      // Token address
                0,          // No ETH value
                ptr,        // Input data pointer
                0x44,       // Input size: 4 (selector) + 32 (to) + 32 (amount)
                ptr,        // Output pointer (reuse input)
                0x20        // Output size: 32 bytes (bool)
            )

            // Check if call succeeded and returned true
            // Some tokens return nothing, so we check returndatasize
            switch returndatasize()
            case 0 {
                // No return data - token doesn't return bool (e.g., USDT)
                // Just check if call succeeded
                if iszero(success) {
                    // Revert with TransferFailed()
                    mstore(ptr, 0x90b8ec1800000000000000000000000000000000000000000000000000000000)
                    revert(ptr, 0x04)
                }
            }
            default {
                // Token returned data - check if it's true
                let returnValue := mload(ptr)
                if or(iszero(success), iszero(returnValue)) {
                    // Revert with TransferFailed()
                    mstore(ptr, 0x90b8ec1800000000000000000000000000000000000000000000000000000000)
                    revert(ptr, 0x04)
                }
            }
        }
    }
}
