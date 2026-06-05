// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.10;

import "./BofhContractBase.sol";
import "../interfaces/ISwapInterfaces.sol";
import "../interfaces/IBofhContract.sol";
import "../libs/SwapMathLib.sol";

/// @title BofhContractV2 - Advanced Multi-Path Token Swap Router
/// @author Bofh Team
/// @notice Executes optimized token swaps across multiple paths using golden ratio distribution
/// @dev Implements 3/4/5-way swap path optimization with comprehensive security features
/// @custom:security Inherits security from BofhContractBase (reentrancy, access control, MEV protection)
/// @custom:optimization Uses golden ratio (φ ≈ 0.618034) for 4-way and 5-way path distribution
contract BofhContractV2 is BofhContractBase, IBofhContract {
    using MathLib for uint256;
    using PoolLib for PoolLib.PoolState;
    using SwapMathLib for address;

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

    // The fee-aware view simulation type (SimReserve) and helpers live in SwapMathLib so the swap
    // hot path and the off-chain views share ONE CPMM-with-fee implementation.

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
    /// @custom:refactor Delegates to SwapMathLib.validateSwapInputs (internal => inlined, byte-identical).
    /// @custom:refactor allowRegistrySentinel=false keeps the single-DEX fee cap (no sentinel exemption).
    function _validateSwapInputs(
        address[] calldata path,
        uint256[] calldata fees,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    ) private view returns (uint256 pathLength) {
        return SwapMathLib.validateSwapInputs(
            baseToken, MAX_PATH_LENGTH, path, fees, amountIn, minAmountOut, deadline, false
        );
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
            SwapMathLib.safeTransferFrom(cachedBaseToken, msg.sender, address(this), amountIn);
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
        SwapMathLib.safeTransfer(baseToken, recipient, state.currentAmount);

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
            SwapMathLib.safeTransferFrom(cachedBaseToken, msg.sender, address(this), amountIn);
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
        SwapMathLib.safeTransfer(baseToken, msg.sender, state.currentAmount);

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
        // allowRegistrySentinel=true permits a fees[i] == USE_REGISTRY_FEE per hop (use registry fee);
        // a concrete fee is still capped at MAX_FEE_BPS. Otherwise byte-identical to _validateSwapInputs.
        return SwapMathLib.validateSwapInputs(
            baseToken, MAX_PATH_LENGTH, path, fees, amountIn, minAmountOut, deadline, true
        );
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
        // Delegate the per-hop mechanics (pair resolution, pool analysis/validation, pricing, pre-fund,
        // swap, balanceOf-delta sizing) to SwapMathLib.executeHop. It is `internal` (inlined), so the
        // token-flow order, the CPMM-with-fee formula, and gas are byte-identical to the prior in-line
        // implementation. The contract retains the SwapState struct and only writes back the results.
        (state.currentAmount, state.cumulativeImpact) = SwapMathLib.executeHop(
            pairFactory,
            tokenIn,
            tokenOut,
            feeBps,
            state.currentAmount,
            state.cumulativeImpact,
            maxPriceImpact,
            MAX_SLIPPAGE,
            fotSafe
        );
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
        (expectedOutput, priceImpact) = SwapMathLib.simulatePath(factory, path, fees, amounts[0]);

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
        (expectedOutput, priceImpact) = SwapMathLib.simulatePathMultiDex(path, factories, hopFees, amounts[0]);

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

    // The fee-aware path-simulation helpers (simulatePath / simulatePathMultiDex / simHop / findSim /
    // liveReserves / priceImpact) and the SimReserve type live in SwapMathLib. They are pure/view and
    // read no contract storage, so getOptimalPathMetricsWithFees/getOptimalPathMetricsMultiDex call
    // SwapMathLib.simulatePath(factory, ...) / SwapMathLib.simulatePathMultiDex(...) directly.

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
}
