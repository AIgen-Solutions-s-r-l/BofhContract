// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.10;

import "./BofhContractBase.sol";
import "../interfaces/ISwapInterfaces.sol";
import "../interfaces/IBofhContract.sol";

/// @title BofhContractV2 - Advanced Multi-Path Token Swap Router
/// @author Bofh Team
/// @notice Executes optimized token swaps across multiple paths using golden ratio distribution
/// @dev Implements 3/4/5-way swap path optimization with comprehensive security features
/// @custom:security Inherits security from BofhContractBase (reentrancy, access control, MEV protection)
/// @custom:optimization Uses golden ratio (φ ≈ 0.618034) for 4-way and 5-way path distribution
contract BofhContractV2 is BofhContractBase, IBofhContract {
    using MathLib for uint256;
    using PoolLib for PoolLib.PoolState;

    /// @notice Base token address (all swap paths must start and end with this token)
    address private immutable baseToken;

    /// @notice Uniswap V2-style factory address for pair lookups
    address private immutable factory;

    /// @notice Maximum allowed per-hop fee in basis points out of 10000 (10% = 1000 bps)
    /// @dev Tightened from 10000 (100%) to 1000 (10%): rejects absurd fees while still covering
    /// @dev real-world DEX forks. Per-fee validation in _validateSwapInputs enforces this cap.
    uint256 private constant MAX_FEE_BPS = 1000;

    /// @notice Internal state tracking for multi-step swap execution
    /// @dev Minimal state for tracking swap progress across multiple hops
    /// @custom:field currentToken Address of current token in swap path
    /// @custom:field currentAmount Current token amount after each hop
    /// @custom:field cumulativeImpact Accumulated price impact across all hops
    /// @custom:optimization Removed unused fields (historicalAmounts, startTime, gasUsed) for gas savings
    struct SwapState {
        address currentToken;
        uint256 currentAmount;
        uint256 cumulativeImpact;
    }

    // Custom errors inherited from IBofhContract interface

    /// @notice Thrown when base token address is zero (constructor validation)
    error InvalidBaseToken();

    /// @notice Thrown when factory address is zero (constructor validation)
    error InvalidFactory();

    // Additional errors inherited from IBofhContract interface:
    // TransferFailed, UnprofitableExecution

    /// @notice Deploy BofhContractV2 with base token and factory addresses
    /// @dev Validates addresses are non-zero, initializes immutable state
    /// @param baseToken_ Address of base token (WBNB, WETH, etc.) - all paths start/end here
    /// @param factory_ Address of Uniswap V2-style factory for pair creation/lookup
    /// @custom:security Both addresses validated to be non-zero before assignment
    /// @custom:security Calls parent constructor with msg.sender as owner
    constructor(
        address baseToken_,
        address factory_
    ) BofhContractBase(msg.sender, baseToken_) {
        if (baseToken_ == address(0)) revert InvalidBaseToken();
        if (factory_ == address(0)) revert InvalidFactory();
        baseToken = baseToken_;
        factory = factory_;
    }

    /// @notice Validate all swap parameters before execution
    /// @dev Comprehensive validation: deadline, array lengths, amounts, addresses, path structure, fees
    /// @dev Validates: 1) Deadline not expired, 2) Arrays correct length, 3) Amounts > 0,
    /// @dev 4) Addresses non-zero, 5) Path starts/ends with baseToken, 6) Fees ≤ MAX_FEE_BPS (10%)
    /// @param path Token swap path (must start and end with baseToken)
    /// @param fees Fee array in basis points (length = path.length - 1)
    /// @param amountIn Input amount (must be > 0)
    /// @param minAmountOut Minimum output amount (must be > 0)
    /// @param deadline Transaction deadline Unix timestamp (must be > block.timestamp)
    /// @return pathLength Length of the path for gas-optimized loops
    /// @custom:security Reverts with specific errors for each validation failure
    /// @custom:security Added in Issue #8 for comprehensive input sanitization
    function _validateSwapInputs(
        address[] calldata path,
        uint256[] calldata fees,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    ) private view returns (uint256 pathLength) {
        // 1. Deadline validation
        if (deadline == 0) revert InvalidAmount();
        if (block.timestamp > deadline) revert DeadlineExpired();

        // 2. Array length validation
        pathLength = path.length;
        if (pathLength == 0) revert InvalidArrayLength();
        if (pathLength < 2 || pathLength > MAX_PATH_LENGTH) revert InvalidPath();
        if (pathLength != fees.length + 1) revert InvalidArrayLength();

        // 3. Amount validation
        if (amountIn == 0) revert InvalidAmount();
        if (minAmountOut == 0) revert InvalidAmount();

        // 4. Path address validation
        for (uint256 i = 0; i < pathLength;) {
            if (path[i] == address(0)) revert InvalidAddress();
            unchecked { ++i; }
        }

        // 5. Path structure validation (cache baseToken to avoid double SLOAD)
        address cachedBaseToken = baseToken;
        if (path[0] != cachedBaseToken || path[pathLength - 1] != cachedBaseToken) revert InvalidPath();

        // 6. Fee validation (fees must be reasonable, max MAX_FEE_BPS = 1000 bps = 10%)
        for (uint256 i = 0; i < fees.length;) {
            if (fees[i] > MAX_FEE_BPS) revert InvalidFee();
            unchecked { ++i; }
        }
    }

    /// @notice Internal function to execute swap through multiple pools along path
    /// @dev Validates inputs, transfers tokens, executes each hop, validates output
    /// @dev Steps: 1) Validate inputs, 2) Transfer from user, 3) Execute path steps,
    /// @dev 4) Validate output ≥ minAmountOut, 5) Check price impact ≤ maxPriceImpact,
    /// @dev 6) Transfer profit to user, 7) Emit SwapExecuted event
    /// @param path Token addresses array (must start/end with baseToken)
    /// @param fees Fee array in basis points for each hop
    /// @param amountIn Input token amount
    /// @param minAmountOut Minimum acceptable output (reverts if not met)
    /// @param deadline Transaction deadline
    /// @return Final output amount sent to user
    /// @custom:security Validates all inputs via _validateSwapInputs before execution
    /// @custom:security Tracks cumulative price impact and validates against maxPriceImpact
    /// @custom:security Uses SafeTransfer pattern (require statements) for token transfers
    function _executeSwap(
        address[] calldata path,
        uint256[] calldata fees,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    ) internal returns (uint256) {
        return _executeSwapToRecipient(path, fees, amountIn, minAmountOut, deadline, msg.sender);
    }

    /// @notice Execute a swap and send output to specified recipient
    /// @dev Internal function used by both single swaps and batch swaps
    /// @param path Token swap path
    /// @param fees Fee array in basis points
    /// @param amountIn Input amount
    /// @param minAmountOut Minimum output amount
    /// @param deadline Transaction deadline
    /// @param recipient Address to receive output tokens
    /// @return Final output amount sent to recipient
    /// @custom:security Validates all inputs via _validateSwapInputs
    /// @custom:implementation Added in Issue #31 for batch swap support
    function _executeSwapToRecipient(
        address[] calldata path,
        uint256[] calldata fees,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline,
        address recipient
    ) internal returns (uint256) {
        // Comprehensive input validation (Issue #8)
        uint256 pathLength = _validateSwapInputs(path, fees, amountIn, minAmountOut, deadline);

        // Initialize swap state and transfer tokens (scoped to avoid stack depth issues)
        uint256 lastIndex;
        SwapState memory state;
        {
            // Gas optimization: Cache baseToken to avoid multiple SLOAD operations
            address cachedBaseToken = baseToken;

            lastIndex = pathLength - 1;
            state = SwapState({
                currentToken: cachedBaseToken,
                currentAmount: amountIn,
                cumulativeImpact: 0
            });

            // Transfer initial amount from user (Phase 3: optimized)
            _safeTransferFrom(cachedBaseToken, msg.sender, address(this), amountIn);
        }

        // Execute swaps along the path
        for (uint256 i = 0; i < lastIndex;) {
            state = executePathStep(
                state,
                path[i],
                path[i + 1],
                fees[i]
            );

            unchecked {
                ++i;
            }
        }

        // Validate final output
        if (state.currentAmount < minAmountOut) revert InsufficientOutput();

        // Calculate total price impact and validate
        // Gas optimization: Use unchecked for multiplication (overflow not possible with PRECISION = 1e6)
        uint256 priceImpact;
        unchecked {
            priceImpact = (state.cumulativeImpact * PRECISION) / amountIn;
        }
        if (priceImpact > maxPriceImpact) revert ExcessiveSlippage();

        // Transfer profit to recipient (Phase 3: optimized)
        _safeTransfer(baseToken, recipient, state.currentAmount);

        emit SwapExecuted(
            msg.sender,
            pathLength,
            amountIn,
            state.currentAmount,
            priceImpact
        );

        return state.currentAmount;
    }

    /// @notice Execute a swap through a single path
    /// @dev Implements virtual function from BofhContractBase with required security modifiers
    /// @dev Protected by: nonReentrant (reentrancy guard), whenNotPaused (circuit breaker), antiMEV (flash loan protection)
    /// @dev MEV Protection (Issue #9): Limits transactions per block and enforces delay between transactions
    /// @param path Array of token addresses representing the swap path
    /// @param fees Array of fee amounts for each swap step
    /// @param amountIn Input amount for the swap
    /// @param minAmountOut Minimum acceptable output amount (slippage protection)
    /// @param deadline Unix timestamp after which the transaction will revert
    /// @return The actual output amount from the swap
    function executeSwap(
        address[] calldata path,
        uint256[] calldata fees,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    ) external override(BofhContractBase, IBofhContract) nonReentrant whenNotPaused antiMEV returns (uint256) {
        return _executeSwap(path, fees, amountIn, minAmountOut, deadline);
    }

    /// @notice Execute multiple swaps through different paths in parallel
    /// @dev Implements virtual function from BofhContractBase with required security modifiers
    /// @dev Protected by: nonReentrant (reentrancy guard), whenNotPaused (circuit breaker), antiMEV (flash loan detection)
    /// @dev Issue #24: Added antiMEV modifier after refactoring to reduce stack depth
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
    ) external override(BofhContractBase, IBofhContract) nonReentrant whenNotPaused antiMEV returns (uint256[] memory) {
        // === Comprehensive Input Validation (Issue #8) ===

        // 1. Deadline validation
        if (deadline == 0) revert InvalidAmount();
        if (block.timestamp > deadline) revert DeadlineExpired();

        // 2. Array length consistency validation
        uint256 numPaths = paths.length;
        if (numPaths == 0) revert InvalidArrayLength();
        if (numPaths != fees.length) revert InvalidArrayLength();
        if (numPaths != amounts.length) revert InvalidArrayLength();
        if (numPaths != minAmounts.length) revert InvalidArrayLength();

        // 3. Per-path validation (will be done in _executeSwap for each path)
        // Note: Individual path validations happen in _executeSwap

        uint256[] memory outputs = new uint256[](numPaths);
        uint256 totalInput = 0;
        uint256 totalOutput = 0;

        // Execute each path
        for (uint256 i = 0; i < numPaths;) {
            unchecked {
                totalInput += amounts[i];
                outputs[i] = _executeSwap(
                    paths[i],
                    fees[i],
                    amounts[i],
                    minAmounts[i],
                    deadline
                );
                totalOutput += outputs[i];
                ++i;
            }
        }

        // Verify total profitability
        if (totalOutput <= totalInput) revert UnprofitableExecution();

        return outputs;
    }

    /// @notice Execute a batch of independent swaps in a single transaction
    /// @dev Protected by reentrancy guard, circuit breaker, and MEV protection
    /// @dev All swaps execute atomically - if any fails, all revert
    /// @dev Maximum batch size: 10 swaps to prevent gas limit issues
    /// @param swaps Array of SwapParams structs, one per swap in the batch
    /// @return outputs Array of actual output amounts for each swap
    /// @custom:security Each swap independently validated (deadline, amounts, addresses)
    /// @custom:security Batch size limited to 10 to prevent DoS via gas exhaustion
    /// @custom:security MEV protection applied at batch level (not per-swap)
    /// @custom:gas Saves ~28,000 gas per swap vs individual transactions
    /// @custom:implementation Added in Issue #31 for batch operations support
    function executeBatchSwaps(IBofhContract.SwapParams[] calldata swaps)
        external
        override(IBofhContract)
        nonReentrant
        whenNotPaused
        antiMEV
        returns (uint256[] memory outputs)
    {
        // === Batch Size Validation ===
        uint256 batchSize = swaps.length;
        if (batchSize == 0) revert InvalidArrayLength();
        if (batchSize > 10) revert BatchSizeExceeded();

        // === Initialize Output Array and Accumulators ===
        outputs = new uint256[](batchSize);
        uint256 totalInputs = 0;
        uint256 totalOutputs = 0;

        // === Execute Each Swap in the Batch ===
        for (uint256 i = 0; i < batchSize;) {
            IBofhContract.SwapParams calldata swap = swaps[i];

            // Validate recipient address (allow different recipients per swap)
            if (swap.recipient == address(0)) revert InvalidAddress();

            // Accumulate total input
            unchecked {
                totalInputs += swap.amountIn;
            }

            // Execute the swap and send output to recipient
            // Validation happens in _executeSwapToRecipient
            uint256 outputAmount = _executeSwapToRecipient(
                swap.path,
                swap.fees,
                swap.amountIn,
                swap.minAmountOut,
                swap.deadline,
                swap.recipient
            );

            // Store output and accumulate total
            outputs[i] = outputAmount;
            unchecked {
                totalOutputs += outputAmount;
                ++i;
            }
        }

        // === Emit Batch Execution Event ===
        emit BatchSwapExecuted(msg.sender, batchSize, totalInputs, totalOutputs);

        return outputs;
    }

    /// @notice Execute a single step in a multi-hop swap path
    /// @dev Executes swap through pair, updates swap state with new amount and cumulative price impact
    /// @param state Current swap state (token, amount, impact)
    /// @param tokenIn Input token address for this step
    /// @param tokenOut Output token address for this step
    /// @param feeBps Per-hop swap fee in basis points out of 10000 (e.g. 30 = 0.3%, 25 = 0.25%)
    /// @return Updated swap state with new currentAmount and cumulativeImpact
    /// @custom:security Validates pool liquidity and calculates price impact before swap
    /// @custom:optimization Removed unused parameters (stepIndex, pathLength) for gas savings
    /// @custom:fee Consumes the caller-supplied per-hop fee so the router prices correctly on
    /// @custom:fee DEXes with non-0.3% fees (Pancake 0.25%, Uniswap 0.3%, higher-fee forks)
    function executePathStep(
        SwapState memory state,
        address tokenIn,
        address tokenOut,
        uint256 feeBps
    ) private returns (SwapState memory) {
        // Defense-in-depth: the assembly below computes (10000 - feeBps). Callers reach this
        // private helper only via _validateSwapInputs (which enforces fees[i] <= MAX_FEE_BPS),
        // but re-check here so the subtraction can never underflow if a future caller forgets.
        if (feeBps > MAX_FEE_BPS) revert InvalidFee();

        // Get the pair address for these two tokens
        address pairAddress = _getPair(tokenIn, tokenOut);

        // Analyze pool state using the pair address
        PoolLib.PoolState memory pool = PoolLib.analyzePool(
            pairAddress,
            tokenIn,
            state.currentAmount,
            block.timestamp
        );

        // Calculate optimal swap parameters
        PoolLib.SwapParams memory params = PoolLib.SwapParams({
            amountIn: state.currentAmount,
            minAmountOut: 0, // Calculated dynamically
            maxPriceImpact: maxPriceImpact,
            deadline: block.timestamp + 1, // Immediate execution
            maxSlippage: MAX_SLIPPAGE
        });

        // Validate pool state
        if (!PoolLib.validateSwap(pool, params)) revert InvalidSwapParameters();

        // Calculate expected output using constant product formula (x * y = k)
        // amountOut = (amountIn * reserveOut * (10000 - feeBps)) /
        //             (reserveIn * 10000 + amountIn * (10000 - feeBps))
        // feeBps is a 10000-basis per-hop fee (30 = 0.3%, reproducing the legacy 997/1000 result).
        // Phase 3 optimization: Assembly for maximum gas efficiency
        uint256 expectedOutput;
        assembly {
            // Load values from memory
            let amountIn := mload(add(state, 0x20)) // state.currentAmount
            let reserveOut := mload(add(pool, 0x20)) // pool.reserveOut (2nd field after reserveIn)
            let reserveIn := mload(pool) // pool.reserveIn (1st field)

            // Calculate: feeNum = 10000 - feeBps (feeBps=30 -> 9970, i.e. legacy 0.3%)
            let feeNum := sub(10000, feeBps)

            // Calculate: amountInWithFee = amountIn * feeNum
            let amountInWithFee := mul(amountIn, feeNum)

            // Calculate: numerator = amountInWithFee * reserveOut
            let numerator := mul(amountInWithFee, reserveOut)

            // Calculate: denominator = reserveIn * 10000 + amountInWithFee
            let denominator := add(mul(reserveIn, 10000), amountInWithFee)

            // Calculate: expectedOutput = numerator / denominator
            expectedOutput := div(numerator, denominator)
        }

        // Add price impact (keep in Solidity for struct access simplicity)
        unchecked {
            state.cumulativeImpact += pool.priceImpact;
        }

        // Transfer tokens to the pair contract (Uniswap V2 pattern)
        // Phase 3 optimization: Low-level call for gas efficiency
        _safeTransfer(tokenIn, pairAddress, state.currentAmount);

        {
            uint256 balanceBefore = IBEP20(tokenOut).balanceOf(address(this));

            // Execute swap on the pair contract
            IGenericPair(pairAddress).swap(
                pool.sellingToken0 ? 0 : expectedOutput,
                pool.sellingToken0 ? expectedOutput : 0,
                address(this),
                new bytes(0)
            );

            state.currentAmount = IBEP20(tokenOut).balanceOf(address(this)) - balanceBefore;
        }
        state.currentToken = tokenOut;

        return state;
    }

    /// @notice Calculate expected output, price impact, and optimality score for a swap path
    /// @dev View function for off-chain simulation before executing swap
    /// @dev Iterates through path, analyzes each pool, accumulates impact, calculates expected output
    /// @param path Array of token addresses for the swap path
    /// @param amounts Array of amounts at each step (amounts[0] is initial input)
    /// @return expectedOutput Final expected output amount after all hops
    /// @return priceImpact Cumulative price impact across entire path (scaled by PRECISION)
    /// @return optimalityScore Ratio of output to input (scaled by PRECISION, >1e6 = profitable)
    /// @custom:view Read-only function, safe for off-chain calls
    /// @custom:example optimalityScore of 1.05e6 means 5% profit
    function getOptimalPathMetrics(
        address[] calldata path,
        uint256[] calldata amounts
    ) external view returns (
        uint256 expectedOutput,
        uint256 priceImpact,
        uint256 optimalityScore
    ) {
        if (path.length < 2 || path.length > MAX_PATH_LENGTH) revert InvalidPath();
        
        uint256 pathLength = path.length - 1;
        uint256 cumulativeImpact = 0;
        expectedOutput = amounts[0];
        
        for (uint256 i = 0; i < pathLength;) {
            address pairAddress = _getPair(path[i], path[i + 1]);
            PoolLib.PoolState memory pool = PoolLib.analyzePool(
                pairAddress,
                path[i],
                expectedOutput,
                block.timestamp
            );

            unchecked {
                cumulativeImpact += pool.priceImpact;
                expectedOutput = (expectedOutput * (PRECISION - pool.priceImpact)) / PRECISION;
                ++i;
            }
        }

        priceImpact = cumulativeImpact;
        unchecked {
            optimalityScore = (expectedOutput * PRECISION) / amounts[0];
        }

        return (expectedOutput, priceImpact, optimalityScore);
    }

    /// @notice Get pair address for two tokens from factory
    /// @dev Helper function to resolve pair address from token addresses
    /// @param tokenA First token address
    /// @param tokenB Second token address
    /// @return pair The pair contract address
    function _getPair(address tokenA, address tokenB) internal view returns (address pair) {
        pair = IFactory(factory).getPair(tokenA, tokenB);
        if (pair == address(0)) revert PairDoesNotExist();
    }

    /// @notice Get the base token address used for swaps
    /// @return The address of the base token
    function getBaseToken() external view returns (address) {
        return baseToken;
    }

    /// @notice Get the factory address
    /// @return The address of the factory
    function getFactory() external view returns (address) {
        return factory;
    }

    /// @notice Safe token transferFrom using low-level call for gas optimization
    /// @dev Phase 3 optimization: Assembly-based transferFrom with proper error handling
    /// @param token Token address to transfer from
    /// @param from Address to transfer from
    /// @param to Recipient address
    /// @param amount Amount to transfer
    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
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
    /// @dev Phase 3 optimization: Assembly-based transfer with proper error handling
    /// @param token Token address to transfer
    /// @param to Recipient address
    /// @param amount Amount to transfer
    function _safeTransfer(address token, address to, uint256 amount) private {
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