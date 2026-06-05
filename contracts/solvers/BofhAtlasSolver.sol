// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.10;

import "./IAtlasSolver.sol";
import "../interfaces/ISwapInterfaces.sol";
import "../interfaces/IBofhContract.sol";
import "../libs/SwapMathLib.sol";

/// @title IBofhContractV2 - the single executor entrypoint this solver drives
/// @notice Minimal view of BofhContractV2 the solver calls. Declared at file scope (Solidity
/// @notice forbids nested interface declarations) so the solver depends only on the one method it
/// @notice actually uses, keeping the coupling surface explicit and small.
interface IBofhContractV2 {
    function executeSwapMultiDex(
        address[] calldata path,
        uint256[] calldata fees,
        uint16[] calldata dexIds,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    ) external returns (uint256);
}

/// @title BofhAtlasSolver - Atlas/FastLane solver leg that settles a backrun via BofhContractV2
/// @author Bofh Team
/// @notice A thin, non-custodial SOLVER CONTRACT for the Atlas (FastLane) sealed-bid backrun OFA.
/// @notice When Atlas calls {atlasSolverCall} with the winning bid, this contract decodes a
/// @notice multi-DEX backrun (path/fees/dexIds/amountIn/minAmountOut), executes it through the
/// @notice already-audited {IBofhContractV2.executeSwapMultiDex} settlement leg, repays the Atlas
/// @notice escrow shortfall, hands the committed bid to the Execution Environment, and forwards
/// @notice any surplus to the configured beneficiary. The executor stays the COMMODITY; the only
/// @notice value this contract adds is gluing that commodity to the Atlas auction handshake.
/// @dev DESIGN: this contract holds NO long-lived inventory. It pulls exactly `amountIn` of the
/// @dev base token from the funding source for the duration of the metacall, swaps it, and the
/// @dev base token returns to this contract as the swap output. From that output it (a) pays the
/// @dev bid to the executionEnvironment and (b) sweeps the remainder to `beneficiary`. If the
/// @dev round-trip does not clear minAmountOut OR cannot cover the bid, it REVERTS — which is the
/// @dev correct signal under Atlas's ex-post blind accounting (the auction simply skips this
/// @dev solver and settles the next-best bid; nothing is half-applied).
/// @custom:security onlyOwner config; atlasSolverCall gated to the registered Atlas + searcher.
/// @custom:noncustodial Inventory is pulled per-call and never parked here between metacalls.
///
/// @dev ====================================================================================
/// @dev  ██  GATE-0 — DO NOT DEPLOY / BOND / PAY FOR AUDIT UNTIL BOTH HOLD  ██
/// @dev ------------------------------------------------------------------------------------
/// @dev  (a) PERMISSIONLESS OFA STILL OPEN: Chainlink ACQUIRED Atlas on 22 Jan 2026 and pivoted
/// @dev      toward SVR-liquidation flow. Verify LIVE, against the target chain's actual Atlas
/// @dev      deployment, that an outside searcher can still register a SolverOperation and win a
/// @dev      permissionless DEX backrun (no Chainlink-gated allowlist). If the DEX-backrun OFA is
/// @dev      closed/allowlisted, this whole play is dead — do not spend on an audit.
/// @dev  (b) EDGE PROVEN ON REAL DATA: research/backtester.js must show net-of-gas GO (not KILL)
/// @dev      on REAL captured opportunities for the target chain/pairs BEFORE bonding capital.
/// @dev
/// @dev  Until (a) AND (b) are signed off, this contract is a SPEC + TEST HARNESS only.
/// @dev  TODO(real-deps): wire IAtlasEscrow to the live Atlas address; confirm the exact
/// @dev  bid-settlement convention (reconcile vs. direct transfer to executionEnvironment) against
/// @dev  the pinned Atlas release on the target chain — the docs evolved across Atlas versions.
/// @dev ====================================================================================
contract BofhAtlasSolver is ISolverContract {
    // ----------------------------------------------------------------------------------------
    // Storage
    // ----------------------------------------------------------------------------------------

    /// @notice Owner / admin (set at deploy; the only address allowed to (re)configure the solver)
    address public owner;

    /// @notice The Atlas contract permitted to invoke {atlasSolverCall}. Calls from anyone else
    /// @notice revert. Set by the owner once the live Atlas address is GATE-0-verified.
    address public atlas;

    /// @notice The searcher EOA whose signed SolverOperations this contract is willing to run.
    /// @notice address(0) means "not yet configured" => atlasSolverCall reverts. Pinning this
    /// @notice prevents a griefing op (signed by some other searcher but pointing `solver` here)
    /// @notice from making this contract perform work / leak value.
    address public authorizedSearcher;

    /// @notice The deployed BofhContractV2 multi-DEX executor that settles the backrun.
    address public executor;

    /// @notice The base token (e.g. WBNB/WETH) the executor round-trips. All backruns start and
    /// @notice end in this token; the bid is paid in it and the surplus is swept in it.
    address public baseToken;

    /// @notice Where post-bid surplus (the realized arbitrage profit) is swept after each win.
    address public beneficiary;

    /// @notice Reentrancy lock for {atlasSolverCall}. The executor it calls is already nonReentrant,
    /// @notice but this guards the NEW external surface (settlement + native reconcile()) on its own,
    /// @notice so a malicious bid/execution-environment/escrow cannot re-enter mid-settlement. A plain
    /// @notice bool is the cheapest defense-in-depth here (single SSTORE set/clear per call).
    bool private _locked;

    // ----------------------------------------------------------------------------------------
    // Events
    // ----------------------------------------------------------------------------------------

    /// @notice Emitted when the owner (re)points the solver at an executor/base token.
    event ExecutorConfigured(address indexed executor, address indexed baseToken);

    /// @notice Emitted when the owner sets the Atlas address + authorized searcher EOA.
    event AtlasConfigured(address indexed atlas, address indexed authorizedSearcher);

    /// @notice Emitted when the beneficiary (surplus sink) is updated.
    event BeneficiaryUpdated(address indexed beneficiary);

    /// @notice Emitted on a settled backrun.
    /// @param executionEnvironment The Atlas EE the bid was paid to
    /// @param bidToken Token the bid was denominated in
    /// @param bidAmount Bid amount paid to the EE
    /// @param grossOut Total base-token output from the round-trip
    /// @param surplus Amount swept to the beneficiary after paying the bid
    event BackrunSettled(
        address indexed executionEnvironment,
        address indexed bidToken,
        uint256 bidAmount,
        uint256 grossOut,
        uint256 surplus
    );

    // ----------------------------------------------------------------------------------------
    // Errors
    // ----------------------------------------------------------------------------------------

    /// @notice Thrown when a privileged call is made by a non-owner.
    error NotOwner();
    /// @notice Thrown when atlasSolverCall is invoked by anyone other than the configured Atlas.
    error NotAtlas();
    /// @notice Thrown when the signing searcher is not the configured authorizedSearcher.
    error UnauthorizedSearcher();
    /// @notice Thrown when the solver has not been fully configured before a call.
    error NotConfigured();
    /// @notice Thrown on a zero address where a real address is required.
    error ZeroAddress();
    /// @notice Thrown when the bid is denominated in a token this solver cannot settle (only the
    /// @notice base token is supported — the round-trip produces base token, nothing else).
    error UnsupportedBidToken();
    /// @notice Thrown when the realized PROFIT (output minus principal) cannot cover the committed
    /// @notice bid — i.e. the backrun is not profitable enough to pay the bid without eating the
    /// @notice solver's own working float. Reverting here keeps Atlas blind-bid accounting honest.
    /// @param available The profit (or output) available to cover the bid
    /// @param bidAmount The bid the solver committed to pay
    error BidNotCovered(uint256 available, uint256 bidAmount);
    /// @notice Thrown when {atlasSolverCall} is re-entered before the in-flight settlement completes.
    error Reentrancy();

    // ----------------------------------------------------------------------------------------
    // Modifiers
    // ----------------------------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Minimal reentrancy guard for {atlasSolverCall}. Defense-in-depth on the new external
    /// @notice surface: the bid transfer, native reconcile(), and surplus sweep all touch addresses
    /// @notice (executionEnvironment / atlas escrow / beneficiary) that could attempt to re-enter.
    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    // ----------------------------------------------------------------------------------------
    // Construction / configuration (owner-only)
    // ----------------------------------------------------------------------------------------

    /// @notice Deploy with the owner set to the deployer; everything else is configured post-deploy
    /// @notice so the live, GATE-0-verified Atlas address can be wired in deliberately (not baked
    /// @notice into bytecode before the OFA's openness is confirmed).
    constructor() {
        owner = msg.sender;
        beneficiary = msg.sender;
    }

    /// @notice Point the solver at the deployed BofhContractV2 executor and its base token.
    /// @dev The executor and base token must agree (the executor's immutable baseToken). We keep
    /// @dev baseToken explicit here so the solver never reads it cross-contract on the hot path.
    /// @param executor_ The deployed BofhContractV2 address
    /// @param baseToken_ The executor's base token (WBNB/WETH/...)
    function configureExecutor(address executor_, address baseToken_) external onlyOwner {
        if (executor_ == address(0) || baseToken_ == address(0)) revert ZeroAddress();
        executor = executor_;
        baseToken = baseToken_;
        emit ExecutorConfigured(executor_, baseToken_);
    }

    /// @notice Set the Atlas contract and the searcher EOA this solver will run for.
    /// @dev GATE-0: only call this with an Atlas address whose permissionless DEX-backrun OFA has
    /// @dev been verified still open post-Chainlink-acquisition.
    /// @param atlas_ The Atlas contract permitted to call atlasSolverCall
    /// @param authorizedSearcher_ The searcher EOA whose signed SolverOperations are honored
    function configureAtlas(address atlas_, address authorizedSearcher_) external onlyOwner {
        if (atlas_ == address(0) || authorizedSearcher_ == address(0)) revert ZeroAddress();
        atlas = atlas_;
        authorizedSearcher = authorizedSearcher_;
        emit AtlasConfigured(atlas_, authorizedSearcher_);
    }

    /// @notice Update where realized surplus is swept after each settled backrun.
    /// @param beneficiary_ New surplus sink (must be non-zero)
    function setBeneficiary(address beneficiary_) external onlyOwner {
        if (beneficiary_ == address(0)) revert ZeroAddress();
        beneficiary = beneficiary_;
        emit BeneficiaryUpdated(beneficiary_);
    }

    /// @notice Transfer ownership of the solver config surface.
    /// @param newOwner The new owner (must be non-zero)
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }

    // ----------------------------------------------------------------------------------------
    // Atlas solver entrypoint
    // ----------------------------------------------------------------------------------------

    /// @notice The ABI of the backrun this solver decodes out of {SolverOperation.data}.
    /// @dev The off-chain searcher encodes exactly these fields (abi.encode) into solverOpData.
    /// @dev fees/dexIds parallel the hops; amountIn is the base-token notional the round-trip
    /// @dev borrows from this contract's balance during the metacall.
    struct Backrun {
        address[] path;
        uint256[] fees;
        uint16[] dexIds;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 deadline;
    }

    /// @inheritdoc ISolverContract
    /// @dev Flow (mirrors the FastLane SolverBase contract, adapted to settle via BofhContractV2):
    /// @dev   1. authZ: msg.sender == atlas, solverOpFrom == authorizedSearcher, fully configured;
    /// @dev   2. bid sanity: only base-token (or native==base proxy) bids are settleable here;
    /// @dev   3. decode the Backrun from solverOpData and run executor.executeSwapMultiDex, which
    /// @dev      pulls amountIn from THIS contract, round-trips it, and returns base token here.
    /// @dev      We force the executor min to >= amountIn + bidAmount (principal + bid) so a
    /// @dev      successful swap structurally preserves principal AND covers the bid (re-checked
    /// @dev      after as defense-in-depth: profit = grossOut - amountIn must be >= bidAmount);
    /// @dev   4. settle: pay `bidAmount` of bidToken to the executionEnvironment so Atlas's ex-post
    /// @dev      accounting nets out; reconcile any Atlas gas shortfall when present;
    /// @dev   5. sweep the POST-BID PROFIT to `beneficiary` (the principal float stays in-contract).
    /// @dev Any failure in 2-4 reverts the whole call -> Atlas skips this solver (blind-bid safe).
    function atlasSolverCall(
        address solverOpFrom,
        address executionEnvironment,
        address bidToken,
        uint256 bidAmount,
        bytes calldata solverOpData,
        bytes calldata /* extraReturnData */
    ) external payable override nonReentrant {
        // --- 1. Authorization ---------------------------------------------------------------
        if (atlas == address(0) || executor == address(0)) revert NotConfigured();
        if (msg.sender != atlas) revert NotAtlas();
        if (solverOpFrom != authorizedSearcher) revert UnauthorizedSearcher();

        address base = baseToken;

        // --- 2. Bid token sanity ------------------------------------------------------------
        // This solver only realizes value in the base token (the round-trip starts and ends in
        // base). A native bid is acceptable iff base is the native-wrapper proxy the caller wired;
        // otherwise an ERC20 bid MUST be the base token. Anything else, we cannot settle -> revert.
        if (bidToken != base && bidToken != address(0)) revert UnsupportedBidToken();

        // --- 3. Execute the backrun via the commodity executor ------------------------------
        Backrun memory br = abi.decode(solverOpData, (Backrun));

        // Defense-in-depth: force the executor's economic backstop to clear PRINCIPAL + BID, so a
        // borderline swap that would dip into principal (or not cover the bid) reverts inside the
        // executor rather than here. The required output is amountIn (principal) + bidAmount; we
        // take the max of that and the searcher's own minAmountOut.
        uint256 bidFloor = br.amountIn + bidAmount; // principal must survive AND bid must be paid
        uint256 enforcedMin = br.minAmountOut > bidFloor ? br.minAmountOut : bidFloor;

        // Approve the executor to pull exactly amountIn of base from this contract for this call.
        // (executeSwapMultiDex does safeTransferFrom(base, msg.sender=this, executor, amountIn).)
        // _safeApprove tolerates non-standard (no-return) base tokens, matching SwapMathLib's
        // success+returndata convention; for standard bool-returning tokens behavior is identical.
        _safeApprove(base, executor, br.amountIn);

        uint256 grossOut = IBofhContractV2(executor).executeSwapMultiDex(
            br.path,
            br.fees,
            br.dexIds,
            br.amountIn,
            enforcedMin,
            br.deadline
        );

        // Clear any residual approval (executor pulls exactly amountIn, but be defensive).
        _safeApprove(base, executor, 0);

        // The executor returns `grossOut` base token to THIS contract (it pays msg.sender == us).
        // The REALIZED PROFIT is grossOut - amountIn: the principal (amountIn) was this solver's own
        // working float and must be preserved so it can run the next metacall. The bid + sweep are
        // therefore paid out of PROFIT, never out of principal. If profit can't cover the bid we
        // revert (BidNotCovered) -> Atlas skips us, blind-bid accounting holds, principal untouched.
        if (grossOut < br.amountIn) revert BidNotCovered(grossOut, bidAmount); // (defense; executor min should already guard)
        uint256 profit = grossOut - br.amountIn;
        if (profit < bidAmount) revert BidNotCovered(profit, bidAmount);

        // --- 4. Settle the bid + Atlas gas shortfall ---------------------------------------
        // Pay the committed bid to the Execution Environment in the bid token. For an ERC20 base
        // token that means transferring `bidAmount` base to the EE; the EE/Atlas accounting then
        // reflects the won bid. For a native bid we'd unwrap+send (left as a TODO below since the
        // mock + this play settle in the ERC20 base token).
        if (bidToken == address(0)) {
            // TODO(native-bid): unwrap WETH/WBNB and send `bidAmount` wei to executionEnvironment.
            // Not exercised by this play (base-token settlement); revert keeps accounting honest.
            revert UnsupportedBidToken();
        }
        if (bidAmount > 0) {
            // Tolerant transfer (success + optional bool returndata) so a no-return base token settles.
            SwapMathLib.safeTransfer(base, executionEnvironment, bidAmount);
        }

        // Reconcile any native gas liability Atlas reports. SolverBase does this via the escrow's
        // shortfall()/reconcile() handshake; we forward whatever native value we were given. When
        // there is no shortfall (or the escrow isn't a reconcile()-style Atlas), this is a no-op.
        _reconcileAtlas();

        // --- 5. Sweep the post-bid PROFIT to the beneficiary (principal stays in the solver) --
        uint256 surplus = profit - bidAmount;
        if (surplus > 0) {
            SwapMathLib.safeTransfer(base, beneficiary, surplus);
        }

        emit BackrunSettled(executionEnvironment, bidToken, bidAmount, grossOut, surplus);
    }

    /// @notice Tolerant ERC20 approve mirroring {SwapMathLib.safeTransfer}'s success+returndata check.
    /// @dev A standard token returns `true`; a non-standard (no-return) token returns zero bytes. Both
    /// @dev are accepted; a `false` return or a failed call reverts with {IBofhContract.TransferFailed}.
    /// @dev Behavior is identical to the previous raw approve() for standard tokens.
    /// @param token Token to approve
    /// @param spender Address allowed to pull
    /// @param amount Allowance to set
    function _safeApprove(address token, address spender, uint256 amount) private {
        (bool success, bytes memory ret) =
            token.call(abi.encodeWithSelector(IBEP20.approve.selector, spender, amount));
        if (!success || (ret.length != 0 && !abi.decode(ret, (bool)))) {
            revert IBofhContract.TransferFailed();
        }
    }

    /// @notice Settle any native gas liability Atlas reports for this metacall.
    /// @dev Mirrors the FastLane SolverBase `safetyFirst` tail: ask the escrow for the outstanding
    /// @dev shortfall and reconcile up to that amount with the native value forwarded into this
    /// @dev call. Wrapped in a low-level staticcall/try so a non-reconcile escrow (e.g. the unit
    /// @dev test mock) does not brick settlement. Real wiring is finalized at GATE-0.
    function _reconcileAtlas() private {
        // Best-effort: only attempt when we actually hold native value to forward.
        uint256 bal = address(this).balance;
        if (bal == 0) return;

        // Ask for the shortfall; tolerate escrows that don't implement it.
        (bool okShort, bytes memory ret) =
            atlas.staticcall(abi.encodeWithSelector(IAtlasEscrow.shortfall.selector));
        if (!okShort || ret.length < 32) return;

        uint256 owed = abi.decode(ret, (uint256));
        if (owed == 0) return;

        uint256 pay = owed < bal ? owed : bal;
        // reconcile is payable; forward `pay`. Tolerate failure (GATE-0 finalizes the convention).
        (bool okRec, ) = atlas.call{value: pay}(
            abi.encodeWithSelector(IAtlasEscrow.reconcile.selector, pay)
        );
        okRec; // intentionally ignored: settlement correctness is re-asserted by Atlas post-call
    }

    /// @notice Owner escape hatch: recover tokens accidentally parked here (this contract is
    /// @notice non-custodial by design, but a misrouted transfer should never be trapped).
    /// @param token The ERC20 to sweep
    /// @param to Recipient
    /// @param amount Amount to sweep
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        // Tolerant transfer so even a misrouted non-standard (no-return) token can be recovered.
        SwapMathLib.safeTransfer(token, to, amount);
    }

    /// @notice Accept native value (Atlas may forward gas value through atlasSolverCall).
    receive() external payable {}
}
