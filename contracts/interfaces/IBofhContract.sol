// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.10;

/// @title IBofhContract
/// @notice Interface for BofhContractV2 - Advanced Multi-Path Token Swap Router
/// @dev Defines core swap execution functions and view functions for external integration
/// @custom:security All swap functions must implement reentrancy protection and access control
interface IBofhContract {
    // ============================================
    // ERRORS
    // ============================================

    /// @notice Thrown when swap path structure is invalid (wrong start/end token, length constraints)
    error InvalidPath();

    /// @notice Thrown when final output amount is less than minAmountOut
    error InsufficientOutput();

    /// @notice Thrown when price slippage exceeds MAX_SLIPPAGE (1%)
    error ExcessiveSlippage();

    /// @notice Thrown when path length exceeds MAX_PATH_LENGTH (5)
    error PathTooLong();

    /// @notice Thrown when block.timestamp > deadline
    error DeadlineExpired();

    /// @notice Thrown when pool liquidity is below minimum threshold
    error InsufficientLiquidity();

    /// @notice Thrown when address parameter is address(0) or invalid
    error InvalidAddress();

    /// @notice Thrown when amount parameter is 0 or invalid
    error InvalidAmount();

    /// @notice Thrown when array lengths don't match expected values
    error InvalidArrayLength();

    /// @notice Thrown when fee exceeds maximum allowed (100% = 10000 bps)
    error InvalidFee();

    /// @notice Thrown when token transfer fails
    error TransferFailed();

    /// @notice Thrown when multi-swap execution is unprofitable
    error UnprofitableExecution();

    /// @notice Thrown when swap parameters are invalid (pool validation fails)
    error InvalidSwapParameters();

    /// @notice Thrown when pair does not exist in factory
    error PairDoesNotExist();

    /// @notice Thrown when batch size exceeds maximum allowed (10 swaps)
    error BatchSizeExceeded();

    // ============================================
    // EVENTS
    // ============================================

    /// @notice Emitted when a batch of swaps is executed
    /// @param executor Address that initiated the batch swap
    /// @param batchSize Number of swaps in the batch
    /// @param totalInputs Total input amounts across all swaps
    /// @param totalOutputs Total output amounts across all swaps
    event BatchSwapExecuted(
        address indexed executor,
        uint256 batchSize,
        uint256 totalInputs,
        uint256 totalOutputs
    );

    // ============================================
    // STRUCTS
    // ============================================

    /// @notice Parameters for a single swap in a batch
    /// @dev Allows different paths, amounts, deadlines, and recipients per swap
    /// @custom:field path Array of token addresses representing the swap path
    /// @custom:field fees Array of fee amounts in basis points (length = path.length - 1)
    /// @custom:field amountIn Input amount for this specific swap
    /// @custom:field minAmountOut Minimum acceptable output amount (slippage protection)
    /// @custom:field deadline Unix timestamp after which this swap will revert
    /// @custom:field recipient Address to receive the output tokens (allows multi-recipient batches)
    struct SwapParams {
        address[] path;
        uint256[] fees;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 deadline;
        address recipient;
    }

    // ============================================
    // CORE SWAP FUNCTIONS
    // ============================================

    /// @notice Execute a swap through a single path
    /// @dev Protected by reentrancy guard, circuit breaker, and MEV protection
    /// @dev Path must start and end with baseToken
    /// @param path Array of token addresses representing the swap path
    /// @param fees Array of fee amounts in basis points for each swap step (length = path.length - 1)
    /// @param amountIn Input amount for the swap in base token
    /// @param minAmountOut Minimum acceptable output amount (slippage protection)
    /// @param deadline Unix timestamp after which the transaction will revert
    /// @return The actual output amount from the swap
    function executeSwap(
        address[] calldata path,
        uint256[] calldata fees,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    ) external returns (uint256);

    /// @notice Execute multiple swaps through different paths in parallel
    /// @dev Protected by reentrancy guard and circuit breaker
    /// @dev All paths must start and end with baseToken
    /// @param paths Array of swap paths, each path is an array of token addresses
    /// @param fees Array of fee arrays, one per path
    /// @param amounts Array of input amounts, one per path
    /// @param minAmounts Array of minimum output amounts, one per path
    /// @param deadline Unix timestamp after which the transaction will revert
    /// @return Array of actual output amounts from each swap path
    function executeMultiSwap(
        address[][] calldata paths,
        uint256[][] calldata fees,
        uint256[] calldata amounts,
        uint256[] calldata minAmounts,
        uint256 deadline
    ) external returns (uint256[] memory);

    /// @notice Execute a batch of independent swaps in a single transaction
    /// @dev Protected by reentrancy guard, circuit breaker, and MEV protection
    /// @dev All swaps execute atomically - if any fails, all revert
    /// @dev Maximum batch size: 10 swaps to prevent gas limit issues
    /// @dev Batch execution provides:
    /// @dev - Gas savings: ~28,000 gas per additional swap (no tx overhead)
    /// @dev - Atomic execution: All swaps succeed or all revert
    /// @dev - Multi-recipient support: Each swap can have different recipient
    /// @dev - Flexible paths: Each swap can use different token paths and deadlines
    /// @param swaps Array of SwapParams structs, one per swap in the batch
    /// @return outputs Array of actual output amounts for each swap
    /// @custom:security Each swap independently validated (deadline, amounts, addresses)
    /// @custom:security Batch size limited to 10 to prevent DoS via gas exhaustion
    /// @custom:security MEV protection applied at batch level (not per-swap)
    /// @custom:gas Saves ~28,000 gas per swap vs individual transactions
    function executeBatchSwaps(SwapParams[] calldata swaps)
        external
        returns (uint256[] memory outputs);

    // NOTE: The multi-DEX entrypoints (executeSwapMultiDex, the 3-arg getOptimalPathMetrics overload,
    // getOptimalPathMetricsMultiDex) and the registry admin (setDex/getDex) are declared directly on
    // BofhContractV2/BofhContractBase, NOT here, so this interface stays minimal and pre-existing
    // implementors (e.g. mocks) are not forced to implement them. They are fully exposed in the
    // contract's own ABI for callers. Add them here in a later PR if a shared interface is needed.

    // ============================================
    // VIEW FUNCTIONS
    // ============================================

    /// @notice Calculate expected output, price impact, and optimality score for a swap path
    /// @dev View function for off-chain simulation before executing swap
    /// @param path Array of token addresses for the swap path
    /// @param amounts Array of amounts at each step (amounts[0] is initial input)
    /// @return expectedOutput Final expected output amount after all hops
    /// @return priceImpact Cumulative price impact across entire path (scaled by PRECISION)
    /// @return optimalityScore Ratio of output to input (scaled by PRECISION, >1e6 = profitable)
    function getOptimalPathMetrics(
        address[] calldata path,
        uint256[] calldata amounts
    ) external view returns (
        uint256 expectedOutput,
        uint256 priceImpact,
        uint256 optimalityScore
    );

    /// @notice Get the base token address used for swaps
    /// @dev All swap paths must start and end with this token
    /// @return The address of the base token
    function getBaseToken() external view returns (address);

    /// @notice Get the factory address
    /// @dev Factory is used for pair lookups via getPair(tokenA, tokenB)
    /// @return The address of the Uniswap V2-style factory
    function getFactory() external view returns (address);
}
