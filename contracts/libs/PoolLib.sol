// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.10;

import "./MathLib.sol";
import "../interfaces/ISwapInterfaces.sol";

/// @title PoolLib - Liquidity Pool Analysis and Management Library
/// @author Bofh Team
/// @notice Provides pool state analysis, price impact calculations, and per-hop swap validation
/// @dev Implements Constant Product Market Maker (CPMM) analysis with volatility tracking
/// @custom:security All functions validate pool liquidity and price impact constraints
library PoolLib {
    /// @notice Base precision for calculations (1,000,000)
    uint256 private constant PRECISION = 1e6;

    /// @notice Minimum required pool liquidity for safe swaps (1,000 tokens)
    uint256 private constant MIN_POOL_LIQUIDITY = 1000;

    /// @notice Pool state snapshot containing reserves, metrics, and historical data
    /// @dev Used for multi-step swap analysis and risk assessment
    /// @custom:field reserveIn Input token reserve in the pool
    /// @custom:field reserveOut Output token reserve in the pool
    /// @custom:field sellingToken0 True if selling token0 for token1, false otherwise
    /// @custom:field tokenOut Address of the output token
    /// @custom:field priceImpact Calculated price impact percentage (scaled by PRECISION)
    /// @custom:field depth Pool depth metric: √(reserveIn × reserveOut)
    /// @custom:field volatility Exponential moving average of price changes
    /// @custom:field lastUpdateTimestamp Last time pool reserves were updated
    /// @custom:field volumeAccumulator Accumulated trading volume for analytics
    struct PoolState {
        uint256 reserveIn;
        uint256 reserveOut;
        bool sellingToken0;
        address tokenOut;
        uint256 priceImpact;
        uint256 depth;
        uint256 volatility;
        uint256 lastUpdateTimestamp;
        uint256 volumeAccumulator;
    }

    /// @notice Swap operation parameters for validation and optimization
    /// @dev Contains all user-specified constraints for swap execution
    /// @custom:field amountIn Amount of input tokens to swap
    /// @custom:field minAmountOut Minimum acceptable output tokens (slippage protection)
    /// @custom:field maxPriceImpact Maximum allowed price impact (scaled by PRECISION)
    /// @custom:field deadline Transaction deadline (Unix timestamp)
    /// @custom:field maxSlippage Maximum allowed slippage percentage (scaled by PRECISION)
    struct SwapParams {
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 maxPriceImpact;
        uint256 deadline;
        uint256 maxSlippage;
    }

    /// @notice Analyze pool state and calculate advanced liquidity metrics
    /// @dev Fetches pool reserves, identifies token direction, and calculates depth/volatility/price impact
    /// @dev Validates minimum liquidity requirements before returning state
    /// @param pool Address of the Uniswap V2-style pair contract
    /// @param tokenIn Address of the input token being sold
    /// @param amountIn Amount of input tokens for the swap
    /// @param timestamp Current block timestamp for volatility calculation
    /// @return state Complete pool state including reserves, metrics, and calculated values
    /// @custom:security Reverts if pool liquidity < MIN_POOL_LIQUIDITY for either token
    /// @custom:example For BASE/TKNA pool with 10k BASE and 5k TKNA, depth = √(10k×5k) ≈ 7071
    /// @custom:optimization Phase 3: Reduced external calls, optimized metric calculations
    function analyzePool(
        address pool,
        address tokenIn,
        uint256 amountIn,
        uint256 timestamp
    ) internal view returns (PoolState memory state) {
        // Single contract reference to reduce external call overhead (Phase 3)
        IGenericPair pair = IGenericPair(pool);
        (uint256 reserve0, uint256 reserve1, uint256 lastTimestamp) = pair.getReserves();

        address token1 = pair.token1();
        state.tokenOut = token1;

        if (tokenIn != token1) {
            address token0 = pair.token0();
            require(tokenIn == token0, "Invalid token");
            state.reserveIn = reserve0;
            state.reserveOut = reserve1;
            state.sellingToken0 = true;
        } else {
            state.tokenOut = pair.token0();
            state.reserveIn = reserve1;
            state.reserveOut = reserve0;
            state.sellingToken0 = false;
        }

        require(
            state.reserveIn >= MIN_POOL_LIQUIDITY &&
            state.reserveOut >= MIN_POOL_LIQUIDITY,
            "Insufficient liquidity"
        );

        // Calculate only essential metrics for swap execution
        // Depth calculation optimized with inline sqrt
        state.depth = MathLib.sqrt(state.reserveIn * state.reserveOut);

        // Skip volatility calculation for same-block swaps (gas optimization)
        state.volatility = (lastTimestamp >= timestamp) ?
            PRECISION / 100 :
            calculateVolatility(state, lastTimestamp, timestamp);

        // Inline price impact calculation for gas savings
        state.priceImpact = _calculatePriceImpactInline(amountIn, state.reserveIn, state.reserveOut);
        state.lastUpdateTimestamp = timestamp;

        return state;
    }

    /// @notice Inline price impact calculation optimized for gas
    /// @dev Avoids memory copies and function call overhead
    /// @param amountIn Amount of input tokens
    /// @param reserveIn Input token reserve
    /// @param reserveOut Output token reserve
    /// @return Price impact scaled by PRECISION
    function _calculatePriceImpactInline(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) private pure returns (uint256) {
        if (amountIn == 0) return 0;

        uint256 newReserveIn = reserveIn + amountIn;
        uint256 newReserveOut = (reserveIn * reserveOut) / newReserveIn;

        uint256 oldPrice = (reserveOut * PRECISION) / reserveIn;
        uint256 newPrice = (newReserveOut * PRECISION) / newReserveIn;

        if (newPrice >= oldPrice) return 0;

        return ((oldPrice - newPrice) * PRECISION) / oldPrice;
    }

    /// @notice Calculate price impact percentage for a given swap amount
    /// @dev Uses CPMM invariant (x×y=k) to compute price change: impact = (oldPrice - newPrice) / oldPrice
    /// @dev Price impact represents the percentage deviation from the current pool price
    /// @param amountIn Amount of input tokens for the swap
    /// @param pool Current pool state with reserves
    /// @return Price impact as percentage scaled by PRECISION (e.g., 50000 = 5%)
    /// @custom:math oldPrice = reserveOut/reserveIn, newPrice = newReserveOut/newReserveIn
    /// @custom:example 100 tokens into 10k/5k pool: newReserveOut ≈ 4950, impact ≈ 1%
    function calculatePriceImpact(
        uint256 amountIn,
        PoolState memory pool
    ) internal pure returns (uint256) {
        if (amountIn == 0) return 0;
        
        uint256 k = pool.reserveIn * pool.reserveOut;
        uint256 newReserveIn = pool.reserveIn + amountIn;
        uint256 newReserveOut = k / newReserveIn; // New reserve after swap
        
        // Calculate price impact as percentage change
        uint256 oldPrice = (pool.reserveOut * PRECISION) / pool.reserveIn;
        uint256 newPrice = (newReserveOut * PRECISION) / newReserveIn;
        
        if (newPrice >= oldPrice) return 0;
        
        return ((oldPrice - newPrice) * PRECISION) / oldPrice;
    }

    /// @notice Calculate pool volatility using exponential moving average (EMA)
    /// @dev Tracks price changes over time with exponential decay: EMA = volatility×decay + priceChange×(1-decay)
    /// @dev Returns minimal volatility (1%) for fresh pools or same-block swaps
    /// @param pool Current pool state with existing volatility and reserves
    /// @param lastTimestamp Previous reserve update timestamp
    /// @param currentTimestamp Current block timestamp
    /// @return Volatility as percentage scaled by PRECISION (e.g., 10000 = 1%)
    /// @custom:math decay = 2^(timeDelta / 1 day), priceChange = |currentPrice - lastVolatility|
    /// @custom:security Returns existing volatility if no time has passed to prevent manipulation
    function calculateVolatility(
        PoolState memory pool,
        uint256 lastTimestamp,
        uint256 currentTimestamp
    ) internal pure returns (uint256) {
        // For pools with no volatility history (pool.volatility == 0), return minimal volatility
        // This includes: fresh pools, same-block multi-hop swaps, and newly initialized pools
        if (pool.volatility == 0 || lastTimestamp == 0) {
            return PRECISION / 100; // 1% minimal volatility
        }

        // If no time has passed, return existing volatility
        if (lastTimestamp >= currentTimestamp) {
            return pool.volatility;
        }

        uint256 timeDelta = currentTimestamp - lastTimestamp;
        if (timeDelta == 0) {
            return pool.volatility;
        }

        // Calculate current price
        uint256 currentPrice = (pool.reserveOut * PRECISION) / pool.reserveIn;

        // Calculate price change
        uint256 priceChange = pool.volatility > currentPrice ?
            pool.volatility - currentPrice :
            currentPrice - pool.volatility;

        // Exponential decay factor based on time delta
        uint256 decay = MathLib.exp2(PRECISION * timeDelta / 1 days);

        return (pool.volatility * decay + priceChange * (PRECISION - decay)) / PRECISION;
    }

    /// @notice Validate swap parameters and pool conditions before execution
    /// @dev Performs comprehensive checks: deadline, amount, price impact, volatility, and depth
    /// @dev Max allowed constraints: 10% price impact, 50% volatility, 10×MIN_POOL_LIQUIDITY depth
    /// @param pool Current pool state to validate
    /// @param params Swap parameters to check against constraints
    /// @return Always returns true if all validations pass (reverts otherwise)
    /// @custom:security Multiple revert conditions protect against invalid swaps:
    /// @custom:security - Expired deadlines, zero amounts, excessive price impact
    /// @custom:security - High volatility pools (>50%), shallow pools (<10k tokens)
    function validateSwap(
        PoolState memory pool,
        SwapParams memory params
    ) internal view returns (bool) {
        require(params.deadline >= block.timestamp, "Deadline expired");
        require(params.amountIn > 0, "Invalid amount");
        require(params.maxPriceImpact <= PRECISION / 10, "Excessive price impact"); // Max 10%
        
        uint256 priceImpact = calculatePriceImpact(params.amountIn, pool);
        require(priceImpact <= params.maxPriceImpact, "Price impact too high");
        
        // Check for extreme pool conditions
        require(pool.volatility <= PRECISION / 2, "Pool too volatile"); // Max 50% volatility
        require(pool.depth >= MIN_POOL_LIQUIDITY * 10, "Pool too shallow");
        
        return true;
    }
}