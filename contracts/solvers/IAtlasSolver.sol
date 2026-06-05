// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.10;

/// @title IAtlasSolver - Atlas / FastLane solver-contract integration surface
/// @author Bofh Team
/// @notice Solidity transcription of the Atlas v1.x solver entrypoint and the SolverOperation
/// @notice handoff, as fetched from the FastLane-Labs/atlas repository and the FastLane
/// @notice searcher-contract-integration docs (Jan 2026 snapshot). A solver contract that wants
/// @notice to win a backrun in an Atlas auction MUST implement {ISolverContract.atlasSolverCall}.
/// @dev SOURCES (verbatim signatures transcribed, NOT invented):
/// @dev   - src/contracts/interfaces/ISolverContract.sol  (atlasSolverCall)
/// @dev   - src/contracts/types/SolverOperation.sol        (struct SolverOperation)
/// @dev   - src/contracts/solver/SolverBase.sol            (reference safetyFirst/payBids flow)
/// @dev   - fastlane-labs.gitbook.io/.../searcher-contract-integration
/// @dev
/// @dev ====================================================================================
/// @dev GATE-0 (READ BEFORE ANY DEPLOY/BOND): On 22 Jan 2026 Chainlink ACQUIRED Atlas and
/// @dev pivoted toward SVR-liquidation flow. The continued OPENNESS of the permissionless
/// @dev DEX-backrun OFA (i.e. that an outside searcher can still register a SolverOperation and
/// @dev win a backrun without a Chainlink-gated allowlist) MUST be verified LIVE before this
/// @dev interface is wired to a real Atlas deployment. Treat the pin below as advisory until
/// @dev re-confirmed against the live Atlas address on the target chain.
/// @dev ====================================================================================

/// @notice The SolverOperation passed through the Atlas pipeline (verbatim field order/types
/// @notice from src/contracts/types/SolverOperation.sol). It is signed by `from` (the searcher
/// @notice EOA) and routed by the Atlas bundler/auctioneer. The solver contract sees the bid
/// @notice parameters as decomposed arguments in {atlasSolverCall}; this struct is included so the
/// @notice off-chain bundler-side encoding and any on-chain helpers reference one definition.
/// @custom:field from EOA that signed this SolverOperation (the searcher)
/// @custom:field to The Atlas contract address (the SolverOperation target)
/// @custom:field value Native value the solver op is allowed to spend
/// @custom:field gas Gas the solver op is metered to
/// @custom:field maxFeePerGas Max fee-per-gas the searcher will pay
/// @custom:field deadline Block number after which the op is invalid
/// @custom:field solver The solver CONTRACT address Atlas will call atlasSolverCall on
/// @custom:field control The DAppControl address governing this auction
/// @custom:field userOpHash Hash binding this solver op to the user op it backruns
/// @custom:field bidToken Token the bid is denominated in (address(0) == native)
/// @custom:field bidAmount Amount of bidToken the solver commits to pay if it wins
/// @custom:field data Calldata forwarded to the solver (decoded by the solver itself)
/// @custom:field signature EIP-712 signature of `from` over the op
struct SolverOperation {
    address from;
    address to;
    uint256 value;
    uint256 gas;
    uint256 maxFeePerGas;
    uint256 deadline;
    address solver;
    address control;
    bytes32 userOpHash;
    address bidToken;
    uint256 bidAmount;
    bytes data;
    bytes signature;
}

/// @title ISolverContract - the single function Atlas invokes on a solver contract
/// @notice Atlas calls this on the contract named by {SolverOperation.solver}. The solver must:
/// @notice  (1) verify msg.sender is the Atlas contract (and, if it cares, that solverOpFrom is
/// @notice      an authorized searcher) — Atlas guarantees ordering but NOT that the solver only
/// @notice      runs for its owner;
/// @notice  (2) execute its MEV strategy using `solverOpData`;
/// @notice  (3) leave `bidAmount` of `bidToken` available so the Atlas escrow accounting nets
/// @notice      out (the SolverBase reference impl repays via reconcile() + a transfer of the
/// @notice      bid to the executionEnvironment); and
/// @notice  (4) revert on any failure so Atlas's ex-post BLIND accounting skips this solver and
/// @notice      tries the next-best bid (a clean revert is the correct "I can't pay" signal).
/// @dev atlasSolverCall is `payable` because native-denominated bids/values flow through it.
interface ISolverContract {
    /// @notice Entry point Atlas invokes for this solver during the solver phase of a metacall.
    /// @param solverOpFrom The EOA that signed the winning SolverOperation (the searcher)
    /// @param executionEnvironment The per-(user,dApp) Execution Environment Atlas is running in;
    /// @param executionEnvironment this is the address the bid must ultimately be payable to
    /// @param bidToken The token the bid is denominated in (address(0) == native asset)
    /// @param bidAmount The amount of bidToken this solver committed to pay if it wins
    /// @param solverOpData The opaque solver calldata (SolverOperation.data) to decode+execute
    /// @param extraReturnData Any data returned by earlier phases (e.g. the userOp/preOps return)
    function atlasSolverCall(
        address solverOpFrom,
        address executionEnvironment,
        address bidToken,
        uint256 bidAmount,
        bytes calldata solverOpData,
        bytes calldata extraReturnData
    ) external payable;
}

/// @title IAtlasEscrow - the slice of the Atlas contract a SolverBase-style solver touches
/// @notice Minimal view of the Atlas escrow used by the reference SolverBase safety modifier to
/// @notice settle borrowed gas/value (reconcile against the reported shortfall). Surfaced here so
/// @notice {BofhAtlasSolver} and {MockAtlas} share ONE definition of the repayment handshake.
/// @dev Real Atlas exposes more; this is intentionally narrow to what the solver leg requires.
interface IAtlasEscrow {
    /// @notice The native/gas liability Atlas expects the solver to cover for this metacall.
    /// @return The outstanding borrow liability (in wei) the solver must reconcile.
    function shortfall() external view returns (uint256);

    /// @notice Repay (some or all of) the outstanding shortfall to the Atlas escrow.
    /// @param maxApprovedGasSpend Amount of native value the solver forwards to settle the debt
    /// @return owed The remaining amount still owed after this reconcile (0 == fully settled)
    function reconcile(uint256 maxApprovedGasSpend) external payable returns (uint256 owed);
}
