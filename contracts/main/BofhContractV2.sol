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

    /// @notice Default per-hop fee in basis points used for the reserved dexId 0 (immutable factory)
    /// @dev 30 = 0.3%, reproducing the legacy 997/1000 result. The multi-DEX worker substitutes
    /// @dev this only when a caller opts in via the type(uint256).max sentinel for that hop.
    uint16 private constant DEFAULT_DEX_FEE_BPS = 30;

    /// @notice Sentinel fee value: when fees[i] == this, substitute the resolved DEX's registry fee
    /// @dev Lets callers say "use whatever this DEX charges" without knowing it, while keeping
    /// @dev an explicit fees[i] caller-authoritative by default.
    uint256 private constant USE_REGISTRY_FEE = type(uint256).max;

    // MAX_FEE_BPS (= 1000) is inherited from DexRegistry so the registry's feeBps validation
    // and this router's _validateSwapInputs reference one single definition.

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

        // Execute swaps along the path (legacy single-DEX: every hop uses the immutable factory).
        // Pass the immutable `factory` directly (no local) to keep the stack footprint unchanged.
        for (uint256 i = 0; i < lastIndex;) {
            state = executePathStep(
                state,
                path[i],
                path[i + 1],
                fees[i],
                factory,
                false // legacy path: no FoT entry/per-hop resizing (byte-identical behavior)
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

    /// @notice Execute a single swap whose hops may route through DIFFERENT registered DEXes
    /// @dev ADDITIVE multi-DEX entrypoint. Same proven token-flow as executeSwap (pre-fund ->
    /// @dev IGenericPair.swap -> balanceOf delta); the ONLY difference is each hop resolves its
    /// @dev pair from a per-hop factory selected by dexIds[i]. dexId 0 = the immutable factory.
    /// @dev Protected by nonReentrant, whenNotPaused, antiMEV (identical to executeSwap).
    /// @param path Token swap path (must start and end with baseToken)
    /// @param fees Per-hop fee array in basis points; fees[i]==type(uint256).max opts into the
    /// @param fees registry feeBps for that hop, otherwise the explicit value is authoritative
    /// @param dexIds Per-hop DEX selector (length = path.length - 1). dexId 0 = immutable factory
    /// @param amountIn Input amount in baseToken
    /// @param minAmountOut Minimum acceptable output (slippage protection)
    /// @param deadline Unix timestamp after which the transaction reverts
    /// @return The actual output amount from the swap
    function executeSwapMultiDex(
        address[] calldata path,
        uint256[] calldata fees,
        uint16[] calldata dexIds,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    ) external nonReentrant whenNotPaused antiMEV returns (uint256) {
        return _executeSwapMultiDex(path, fees, dexIds, amountIn, minAmountOut, deadline);
    }

    /// @notice Multi-DEX swap worker (clone of _executeSwapToRecipient with per-hop factory resolution)
    /// @dev Adds: (1) dexIds length check, (2) per-hop (factory,fee) resolution via _resolveDex,
    /// @dev (3) FoT-aware entry sizing (seed currentAmount from the realized baseToken delta).
    /// @dev Output-side FoT is already correct everywhere because per-hop output is balanceOf-delta based.
    function _executeSwapMultiDex(
        address[] calldata path,
        uint256[] calldata fees,
        uint16[] calldata dexIds,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    ) internal returns (uint256) {
        // Reuse the full input validation (deadline, path structure, amounts, fees <= MAX_FEE_BPS).
        // Note: the registry-fee sentinel (type(uint256).max) is intentionally exempt from the
        // fees[i] <= MAX_FEE_BPS check below by validating the substituted fee per hop instead.
        uint256 pathLength = _validateSwapInputsMultiDex(path, fees, amountIn, minAmountOut, deadline);

        // dexIds must parallel the hops
        if (dexIds.length != pathLength - 1) revert InvalidArrayLength();

        SwapState memory state;
        {
            address cachedBaseToken = baseToken;

            // FoT-aware entry sizing: size the first hop on the RECEIVED baseToken, not the
            // nominal amountIn. For non-FoT tokens received == amountIn (byte-identical behavior).
            uint256 balBefore = IBEP20(cachedBaseToken).balanceOf(address(this));
            _safeTransferFrom(cachedBaseToken, msg.sender, address(this), amountIn);
            uint256 received = IBEP20(cachedBaseToken).balanceOf(address(this)) - balBefore;

            state = SwapState({
                currentToken: cachedBaseToken,
                currentAmount: received,
                cumulativeImpact: 0
            });
        }

        // Execute swaps in a sub-call so the three calldata arrays do not co-exist with the
        // loop locals on the stack (avoids "stack too deep").
        state = _runMultiDexHops(state, path, dexIds, fees);

        // Validate final output
        if (state.currentAmount < minAmountOut) revert InsufficientOutput();

        // Calculate total price impact and validate (uses nominal amountIn, matching legacy path)
        uint256 priceImpact;
        unchecked {
            priceImpact = (state.cumulativeImpact * PRECISION) / amountIn;
        }
        if (priceImpact > maxPriceImpact) revert ExcessiveSlippage();

        // Transfer profit to caller
        _safeTransfer(baseToken, msg.sender, state.currentAmount);

        emit SwapExecuted(
            msg.sender,
            pathLength,
            amountIn,
            state.currentAmount,
            priceImpact
        );

        return state.currentAmount;
    }

    /// @notice Execute each hop of a multi-DEX swap, resolving the factory + fee per hop
    /// @dev Extracted from _executeSwapMultiDex to reduce stack depth (the three calldata arrays
    /// @dev no longer co-exist with the outer scalars/locals). Token-flow is identical to the
    /// @dev legacy loop: pre-fund -> IGenericPair.swap -> balanceOf delta, only the factory varies.
    /// @param state Current swap state (seeded with the FoT-aware received amount)
    /// @param path Token path
    /// @param dexIds Per-hop DEX selector (0 = immutable factory)
    /// @param fees Per-hop caller fees (sentinel => registry fee)
    /// @return Updated swap state after all hops
    function _runMultiDexHops(
        SwapState memory state,
        address[] calldata path,
        uint16[] calldata dexIds,
        uint256[] calldata fees
    ) private returns (SwapState memory) {
        uint256 hops = dexIds.length;
        for (uint256 i = 0; i < hops;) {
            (address f, uint256 hopFee) = _resolveHopFactoryAndFee(dexIds[i], fees[i]);
            state = executePathStep(
                state,
                path[i],
                path[i + 1],
                hopFee,
                f,
                true // multi-DEX path: FoT-safe per-hop output sizing
            );
            unchecked { ++i; }
        }
        return state;
    }

    /// @notice Validate multi-DEX swap inputs, allowing the registry-fee sentinel per hop
    /// @dev Identical to _validateSwapInputs except a fees[i] == type(uint256).max sentinel is
    /// @dev permitted (it means "use the registry's fee"); a concrete fee is still capped at MAX_FEE_BPS.
    function _validateSwapInputsMultiDex(
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

        // 6. Fee validation: concrete fees capped at MAX_FEE_BPS; the registry-fee sentinel is allowed
        for (uint256 i = 0; i < fees.length;) {
            if (fees[i] != USE_REGISTRY_FEE && fees[i] > MAX_FEE_BPS) revert InvalidFee();
            unchecked { ++i; }
        }
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
    /// @param pairFactory Factory to resolve the pair for this hop. The legacy single-DEX path
    /// @param pairFactory passes the immutable `factory` (so behavior is byte-identical); the
    /// @param pairFactory multi-DEX worker passes the per-hop factory resolved from the registry.
    /// @param fotSafe When false (legacy path) the proven assembly pricing + pre-fund order is used
    /// @param fotSafe verbatim. When true (multi-DEX path) the output is sized on the amount the PAIR
    /// @param fotSafe actually receives (measured via balanceOf delta), so fee-on-transfer tokens at
    /// @param fotSafe ANY hop price correctly and never trip the pool's x*y=k ("K") check. For non-FoT
    /// @param fotSafe tokens the pair-received amount equals the amount sent, so results are identical.
    function executePathStep(
        SwapState memory state,
        address tokenIn,
        address tokenOut,
        uint256 feeBps,
        address pairFactory,
        bool fotSafe
    ) private returns (SwapState memory) {
        // Defense-in-depth: the pricing computes (10000 - feeBps). Callers reach this private helper
        // only via validated entrypoints (fees[i] <= MAX_FEE_BPS), but re-check so the subtraction
        // can never underflow if a future caller forgets.
        if (feeBps > MAX_FEE_BPS) revert InvalidFee();

        // Get the pair address for these two tokens from the supplied factory (DEX-specific)
        address pairAddress = _getPairFrom(pairFactory, tokenIn, tokenOut);

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

        // Add price impact (keep in Solidity for struct access simplicity)
        unchecked {
            state.cumulativeImpact += pool.priceImpact;
        }

        if (fotSafe) {
            // FoT-safe: transfer first, size output on the amount the PAIR actually received.
            // Works for fee-on-transfer tokens at any hop; for normal tokens received == sent.
            uint256 pairInBefore = IBEP20(tokenIn).balanceOf(pairAddress);
            _safeTransfer(tokenIn, pairAddress, state.currentAmount);
            uint256 pairReceived = IBEP20(tokenIn).balanceOf(pairAddress) - pairInBefore;

            // Same CPMM-with-fee formula/operation-order as the legacy assembly below.
            uint256 amountInWithFee = pairReceived * (10000 - feeBps);
            uint256 expectedOutput =
                (amountInWithFee * pool.reserveOut) / (pool.reserveIn * 10000 + amountInWithFee);

            uint256 balanceBefore = IBEP20(tokenOut).balanceOf(address(this));
            IGenericPair(pairAddress).swap(
                pool.sellingToken0 ? 0 : expectedOutput,
                pool.sellingToken0 ? expectedOutput : 0,
                address(this),
                new bytes(0)
            );
            state.currentAmount = IBEP20(tokenOut).balanceOf(address(this)) - balanceBefore;
            state.currentToken = tokenOut;
            return state;
        }

        // Legacy path (byte-identical): assembly pricing on state.currentAmount, then pre-fund + swap.
        // amountOut = (amountIn * reserveOut * (10000 - feeBps)) /
        //             (reserveIn * 10000 + amountIn * (10000 - feeBps))
        uint256 legacyExpectedOutput;
        assembly {
            let amountIn := mload(add(state, 0x20)) // state.currentAmount
            let reserveOut := mload(add(pool, 0x20)) // pool.reserveOut
            let reserveIn := mload(pool) // pool.reserveIn
            let feeNum := sub(10000, feeBps)
            let amountInWithFee := mul(amountIn, feeNum)
            let numerator := mul(amountInWithFee, reserveOut)
            let denominator := add(mul(reserveIn, 10000), amountInWithFee)
            legacyExpectedOutput := div(numerator, denominator)
        }

        // Transfer tokens to the pair contract (Uniswap V2 pattern)
        _safeTransfer(tokenIn, pairAddress, state.currentAmount);

        {
            uint256 balanceBefore = IBEP20(tokenOut).balanceOf(address(this));
            IGenericPair(pairAddress).swap(
                pool.sellingToken0 ? 0 : legacyExpectedOutput,
                pool.sellingToken0 ? legacyExpectedOutput : 0,
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

    /// @notice Fee-aware metrics: off-chain mirror of executeSwap that EXACTLY matches realized output
    /// @dev ADDITIVE, DISTINCTLY NAMED (not an overload of getOptimalPathMetrics) so ABI consumers
    /// @dev never face an ambiguous-by-arity selector. Uses the identical constant-product-with-fee
    /// @dev formula as executePathStep (and the same operation order), chaining reserves hop-by-hop so
    /// @dev the returned expectedOutput equals the realized round-trip output of executeSwap to the wei
    /// @dev for standard (non-fee-on-transfer) ERC20s.
    /// @param path Array of token addresses for the swap path (resolved against the immutable factory)
    /// @param amounts Array whose amounts[0] is the initial input
    /// @param fees Per-hop fee array in basis points (length = path.length - 1, each <= MAX_FEE_BPS)
    /// @return expectedOutput Final expected output after all hops
    /// @return priceImpact Cumulative price impact across the path (scaled by PRECISION)
    /// @return optimalityScore Ratio of output to input (scaled by PRECISION, >1e6 = profitable)
    function getOptimalPathMetricsWithFees(
        address[] calldata path,
        uint256[] calldata amounts,
        uint256[] calldata fees
    ) external view returns (
        uint256 expectedOutput,
        uint256 priceImpact,
        uint256 optimalityScore
    ) {
        if (path.length < 2 || path.length > MAX_PATH_LENGTH) revert InvalidPath();
        if (fees.length != path.length - 1) revert InvalidArrayLength();

        // Simulate the full path (tracking per-pair reserve changes) so the result equals exec.
        (expectedOutput, priceImpact) = _simulatePath(path, fees, amounts[0]);

        unchecked {
            optimalityScore = (expectedOutput * PRECISION) / amounts[0];
        }
    }

    /// @notice Fee- and DEX-aware metrics: off-chain mirror of executeSwapMultiDex
    /// @dev ADDITIVE. Resolves each hop's factory (and optional fee) via _resolveDex, then prices
    /// @dev with the same CPMM-with-fee formula as executePathStep so view == exec for multi-DEX paths
    /// @dev of standard (non-fee-on-transfer) ERC20s (FoT/rebasing tokens are not modelled by the view).
    /// @param path Array of token addresses for the swap path
    /// @param amounts Array whose amounts[0] is the initial input
    /// @param dexIds Per-hop DEX selector (length = path.length - 1; dexId 0 = immutable factory)
    /// @param fees Per-hop fee array; fees[i]==type(uint256).max uses the resolved DEX's registry fee
    /// @return expectedOutput Final expected output after all hops
    /// @return priceImpact Cumulative price impact across the path (scaled by PRECISION)
    /// @return optimalityScore Ratio of output to input (scaled by PRECISION, >1e6 = profitable)
    function getOptimalPathMetricsMultiDex(
        address[] calldata path,
        uint256[] calldata amounts,
        uint16[] calldata dexIds,
        uint256[] calldata fees
    ) external view returns (
        uint256 expectedOutput,
        uint256 priceImpact,
        uint256 optimalityScore
    ) {
        if (path.length < 2 || path.length > MAX_PATH_LENGTH) revert InvalidPath();
        if (fees.length != path.length - 1) revert InvalidArrayLength();
        if (dexIds.length != path.length - 1) revert InvalidArrayLength();

        // Resolve per-hop factories + effective fees into memory arrays, then simulate (sub-calls
        // keep the four calldata arrays off the stack during the loop -> avoids "stack too deep").
        (address[] memory factories, uint256[] memory hopFees) = _resolveHops(dexIds, fees);
        (expectedOutput, priceImpact) = _simulatePathMultiDex(path, factories, hopFees, amounts[0]);

        unchecked {
            optimalityScore = (expectedOutput * PRECISION) / amounts[0];
        }
    }

    /// @notice Resolve per-hop (factory, fee) for every hop from dexIds + caller fees
    /// @dev Applies the registry-fee sentinel and caps each effective fee at MAX_FEE_BPS.
    /// @param dexIds Per-hop DEX selector
    /// @param fees Per-hop caller fees (sentinel => registry fee)
    /// @return factories Resolved per-hop factory addresses
    /// @return hopFees Effective per-hop fees in basis points
    function _resolveHops(
        uint16[] calldata dexIds,
        uint256[] calldata fees
    ) private view returns (address[] memory factories, uint256[] memory hopFees) {
        uint256 hops = dexIds.length;
        factories = new address[](hops);
        hopFees = new uint256[](hops);
        for (uint256 i = 0; i < hops;) {
            (address f, uint16 regFee) = _resolveDex(dexIds[i]);
            uint256 hopFee = fees[i] == USE_REGISTRY_FEE ? uint256(regFee) : fees[i];
            if (hopFee > MAX_FEE_BPS) revert InvalidFee();
            factories[i] = f;
            hopFees[i] = hopFee;
            unchecked { ++i; }
        }
    }

    /// @notice Resolve a hop's (factory, fee) from a dexId + caller fee, applying the registry sentinel
    /// @dev Used by the multi-DEX EXECUTION worker. Caps the resolved fee at MAX_FEE_BPS.
    /// @param dexId Per-hop DEX selector (0 = immutable factory)
    /// @param callerFee Caller fee for this hop (type(uint256).max => use the resolved DEX's fee)
    /// @return f Resolved factory address
    /// @return hopFee Effective per-hop fee in basis points (<= MAX_FEE_BPS)
    function _resolveHopFactoryAndFee(uint16 dexId, uint256 callerFee) private view returns (address f, uint256 hopFee) {
        uint16 regFee;
        (f, regFee) = _resolveDex(dexId);
        hopFee = callerFee == USE_REGISTRY_FEE ? uint256(regFee) : callerFee;
        if (hopFee > MAX_FEE_BPS) revert InvalidFee();
    }

    /// @notice Simulate a single-DEX path (all hops via the immutable factory) with reserve tracking
    /// @dev Mirrors realized execution EXACTLY: prices each hop with the CPMM-with-fee formula and
    /// @dev updates the pool's simulated reserves, so revisited pools (e.g. BASE->A->BASE) match exec.
    /// @param path Token path
    /// @param fees Per-hop fees in basis points (each validated <= MAX_FEE_BPS here)
    /// @param amountIn Initial input amount
    /// @return expectedOutput Final output after all hops
    /// @return cumulativeImpact Accumulated price impact across hops
    function _simulatePath(
        address[] calldata path,
        uint256[] calldata fees,
        uint256 amountIn
    ) private view returns (uint256 expectedOutput, uint256 cumulativeImpact) {
        uint256 hops = path.length - 1;
        SimReserve[] memory sims = new SimReserve[](hops);
        uint256 simCount;
        expectedOutput = amountIn;

        for (uint256 i = 0; i < hops;) {
            if (fees[i] > MAX_FEE_BPS) revert InvalidFee();
            (expectedOutput, cumulativeImpact, simCount) = _simHop(
                _getPairFrom(factory, path[i], path[i + 1]),
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
    /// @dev Same reserve-tracking simulation as _simulatePath but each hop uses factories[i].
    /// @param path Token path
    /// @param factories Per-hop resolved factory addresses
    /// @param hopFees Per-hop effective fees in basis points
    /// @param amountIn Initial input amount
    /// @return expectedOutput Final output after all hops
    /// @return cumulativeImpact Accumulated price impact across hops
    function _simulatePathMultiDex(
        address[] calldata path,
        address[] memory factories,
        uint256[] memory hopFees,
        uint256 amountIn
    ) private view returns (uint256 expectedOutput, uint256 cumulativeImpact) {
        uint256 hops = path.length - 1;
        SimReserve[] memory sims = new SimReserve[](hops);
        uint256 simCount;
        expectedOutput = amountIn;

        for (uint256 i = 0; i < hops;) {
            (expectedOutput, cumulativeImpact, simCount) = _simHop(
                _getPairFrom(factories[i], path[i], path[i + 1]),
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
    function _simHop(
        address pairAddress,
        address tokenIn,
        uint256 amountIn,
        uint256 feeBps,
        uint256 cumulativeImpact,
        SimReserve[] memory sims,
        uint256 simCount
    ) private view returns (uint256 amountOut, uint256 newCumulativeImpact, uint256 newSimCount) {
        // Locate (or seed) this pair's simulated reserves in canonical token0/token1 orientation.
        (uint256 idx, bool found) = _findSim(pairAddress, sims, simCount);
        newSimCount = simCount;
        if (!found) {
            // First encounter: read live reserves canonically (token0/token1).
            (uint256 r0, uint256 r1) = _liveReserves(pairAddress);
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
            newCumulativeImpact = cumulativeImpact + _priceImpact(amountIn, reserveIn, reserveOut);
        }

        // Same formula/operation-order as executePathStep's assembly so view == realized exec.
        uint256 amountInWithFee = amountIn * (10000 - feeBps);
        amountOut = (amountInWithFee * reserveOut) / (reserveIn * 10000 + amountInWithFee);

        // Update simulated reserves (canonical orientation) for any later revisit on the path.
        if (inIsToken0) {
            sims[idx].reserve0 = reserveIn + amountIn;
            sims[idx].reserve1 = reserveOut - amountOut;
        } else {
            sims[idx].reserve1 = reserveIn + amountIn;
            sims[idx].reserve0 = reserveOut - amountOut;
        }
    }

    /// @notice Find a pair's index in the tracked sims array
    /// @param pairAddress Pair to look up
    /// @param sims Tracked pair states
    /// @param simCount Populated entries in sims
    /// @return idx Index of the pair (valid only when found)
    /// @return found True if the pair is already tracked
    function _findSim(
        address pairAddress,
        SimReserve[] memory sims,
        uint256 simCount
    ) private pure returns (uint256 idx, bool found) {
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
    function _liveReserves(address pairAddress) private view returns (uint256 reserve0, uint256 reserve1) {
        (reserve0, reserve1, ) = IGenericPair(pairAddress).getReserves();
    }

    /// @notice Price impact for a hop, matching PoolLib._calculatePriceImpactInline exactly
    /// @param amountIn Input amount
    /// @param reserveIn Input token reserve
    /// @param reserveOut Output token reserve
    /// @return Price impact scaled by PRECISION
    function _priceImpact(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) private pure returns (uint256) {
        if (amountIn == 0) return 0;
        uint256 newReserveIn = reserveIn + amountIn;
        uint256 newReserveOut = (reserveIn * reserveOut) / newReserveIn;
        uint256 oldPrice = (reserveOut * PRECISION) / reserveIn;
        uint256 newPrice = (newReserveOut * PRECISION) / newReserveIn;
        if (newPrice >= oldPrice) return 0;
        return ((oldPrice - newPrice) * PRECISION) / oldPrice;
    }

    /// @notice Get pair address for two tokens from the contract's immutable factory
    /// @dev Thin wrapper over _getPairFrom for legacy callers (getOptimalPathMetrics). Byte-identical
    /// @dev to the previous behavior: resolves against `factory` and reverts PairDoesNotExist on zero.
    /// @param tokenA First token address
    /// @param tokenB Second token address
    /// @return pair The pair contract address
    function _getPair(address tokenA, address tokenB) internal view returns (address pair) {
        return _getPairFrom(factory, tokenA, tokenB);
    }

    /// @notice Get pair address for two tokens from an arbitrary V2-style factory
    /// @dev Enables per-hop multi-DEX routing: the same token pair resolves to different pair
    /// @dev addresses on different DEX factories. Reverts PairDoesNotExist if the factory has no pair.
    /// @param pairFactory Uniswap-V2-style factory to query
    /// @param tokenA First token address
    /// @param tokenB Second token address
    /// @return pair The pair contract address
    function _getPairFrom(address pairFactory, address tokenA, address tokenB) internal view returns (address pair) {
        pair = IFactory(pairFactory).getPair(tokenA, tokenB);
        if (pair == address(0)) revert PairDoesNotExist();
    }

    /// @notice Resolve a dexId to its (factory, feeBps) — overrides DexRegistry where `factory` is visible
    /// @dev dexId 0 is reserved for the immutable factory and needs ZERO registry writes (the legacy
    /// @dev single-DEX deployment behaves exactly as today). dexId > 0 reads the registry mapping and
    /// @dev reverts DexNotRegistered if the factory is unset or the DEX is disabled.
    /// @param dexId Registry id to resolve
    /// @return f Factory address for the resolved DEX
    /// @return feeBps Flat per-hop fee for the resolved DEX
    function _resolveDex(uint16 dexId) internal view override returns (address f, uint16 feeBps) {
        if (dexId == 0) return (factory, DEFAULT_DEX_FEE_BPS);
        DexInfo storage d = _dexRegistry[dexId];
        if (d.factory == address(0) || !d.enabled) revert DexNotRegistered(dexId);
        return (d.factory, d.feeBps);
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