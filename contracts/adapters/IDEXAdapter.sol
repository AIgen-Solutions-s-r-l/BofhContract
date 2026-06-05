// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.10;

/// @title IDEXAdapter
/// @notice Interface for DEX adapter implementations supporting multiple protocols
/// @dev Abstracts DEX-specific logic (Uniswap V2, PancakeSwap, SushiSwap, etc.)
/// @custom:pattern Adapter Pattern - Provides uniform interface to different DEX implementations
/// @custom:warning NOT used by BofhContractV2's swap hot path. The router does multi-DEX routing via
/// @custom:warning the on-chain DexRegistry ({factory, feeBps} per dexId) and keeps its proven
/// @custom:warning pre-fund -> IGenericPair.swap -> balanceOf-delta token-flow. Adapter executeSwap
/// @custom:warning pulls via transferFrom(msg.sender) and reprices with a hardcoded fee, which would
/// @custom:warning double-pull intermediate tokens and re-introduce the "K"-revert fee bug. These
/// @custom:warning adapters remain quote/off-chain helpers only.
interface IDEXAdapter {
    // ============================================
    // EVENTS
    // ============================================

    /// @notice Emitted when a swap is executed through the adapter
    /// @param tokenIn Input token address
    /// @param tokenOut Output token address
    /// @param amountIn Input amount
    /// @param amountOut Output amount received
    /// @param pool Pool address used for swap
    event SwapExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address pool
    );

    // ============================================
    // ERRORS
    // ============================================

    /// @notice Thrown when pool/pair does not exist for token pair
    error PoolNotFound();

    /// @notice Thrown when reserves are invalid or zero
    error InvalidReserves();

    /// @notice Thrown when swap execution fails
    error SwapFailed();

    /// @notice Thrown when token addresses are invalid
    error InvalidTokens();

    // ============================================
    // CORE FUNCTIONS
    // ============================================

    /// @notice Get the pool/pair address for a token pair
    /// @dev Implementation must handle token ordering (tokenA < tokenB or vice versa)
    /// @param tokenA First token address
    /// @param tokenB Second token address
    /// @return pool The pool/pair contract address
    function getPoolAddress(address tokenA, address tokenB)
        external
        view
        returns (address pool);

    /// @notice Get reserves for a specific pool
    /// @dev Returns reserves in the order (reserve0, reserve1) as defined by pool's token0/token1
    /// @param pool Pool/pair address
    /// @return reserve0 Reserve of token0
    /// @return reserve1 Reserve of token1
    /// @return blockTimestampLast Timestamp of last reserve update
    function getReserves(address pool)
        external
        view
        returns (
            uint256 reserve0,
            uint256 reserve1,
            uint256 blockTimestampLast
        );

    /// @notice Get token0 and token1 addresses from pool
    /// @dev Used to determine which reserve corresponds to which token
    /// @param pool Pool/pair address
    /// @return token0 Address of token0
    /// @return token1 Address of token1
    function getTokens(address pool)
        external
        view
        returns (address token0, address token1);

    /// @notice Execute a swap through the pool
    /// @dev Implementation must handle token transfers and pool-specific swap logic
    /// @param pool Pool/pair address to swap through
    /// @param tokenIn Input token address
    /// @param tokenOut Output token address
    /// @param amountIn Input amount (must be pre-transferred to pool for some DEXs)
    /// @param amountOutMin Minimum output amount (slippage protection)
    /// @param to Recipient address for output tokens
    /// @return amountOut Actual output amount received
    function executeSwap(
        address pool,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        address to
    ) external returns (uint256 amountOut);

    /// @notice Calculate expected output amount for a swap (view function)
    /// @dev Uses constant product formula: amountOut = (amountIn * reserveOut) / (reserveIn + amountIn)
    /// @dev Should account for fees specific to the DEX
    /// @param pool Pool/pair address
    /// @param tokenIn Input token address
    /// @param amountIn Input amount
    /// @return amountOut Expected output amount (before slippage)
    function getAmountOut(
        address pool,
        address tokenIn,
        uint256 amountIn
    ) external view returns (uint256 amountOut);

    // ============================================
    // METADATA FUNCTIONS
    // ============================================

    /// @notice Get the name of the DEX protocol
    /// @dev Used for logging and debugging
    /// @return Name of DEX (e.g., "Uniswap V2", "PancakeSwap", "SushiSwap")
    function getDEXName() external pure returns (string memory);

    /// @notice Get the factory address for this DEX
    /// @dev Factory is used to look up pair/pool addresses
    /// @return Factory contract address
    function getFactory() external view returns (address);

    /// @notice Get the fee structure for this DEX
    /// @dev Returns fee in basis points (e.g., 30 = 0.3%, 25 = 0.25%)
    /// @return feeBps Fee in basis points
    function getFeeBps() external pure returns (uint256 feeBps);

    /// @notice Check if a pool exists and is valid
    /// @param pool Pool/pair address to check
    /// @return exists True if pool exists and has non-zero reserves
    function isValidPool(address pool) external view returns (bool exists);
}
