// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.10;

import "../solvers/IAtlasSolver.sol";
import "../interfaces/ISwapInterfaces.sol";

/// @title MockAtlas - minimal Atlas escrow/callback stand-in for solver integration tests
/// @author Bofh Team
/// @notice A deliberately tiny model of the Atlas metacall: it plays the role of the Atlas
/// @notice contract (the only address allowed to call {ISolverContract.atlasSolverCall}) and the
/// @notice Execution Environment (the address the bid is paid to), and exposes the
/// @notice {IAtlasEscrow.shortfall}/{IAtlasEscrow.reconcile} handshake so the solver's gas-debt
/// @notice settlement path is exercised. It is NOT a faithful Atlas — it captures only the slice
/// @notice the {BofhAtlasSolver} touches, so tests can run atlasSolverCall end-to-end against the
/// @notice existing MockFactory/MockPair/MockToken stack.
/// @dev The mock asserts the BLIND-BID invariant for the test: after invoking the solver it checks
/// @dev that the Execution Environment actually received `bidAmount` of the bid token. If the
/// @dev solver reverts (unprofitable / under-min / unauthorized), this whole metacall reverts and
/// @dev the mock observes nothing was paid — matching Atlas skipping a non-paying solver.
contract MockAtlas is IAtlasEscrow {
    /// @notice The Execution Environment the bid must be paid to (here: this contract itself,
    /// @notice unless overridden) so the mock can assert receipt.
    address public executionEnvironment;

    /// @notice Configurable native gas shortfall the solver is expected to reconcile (0 by default
    /// @notice so the ERC20-only happy path doesn't require funding the solver with native value).
    uint256 public reportedShortfall;

    /// @notice How much native value the solver actually reconciled in the last metacall.
    uint256 public lastReconciled;

    /// @notice Records the bid-token balance the EE held before the last metacall (for assertions).
    uint256 public eeBalanceBefore;

    /// @notice Emitted after a successful metacall so tests can assert on the settled bid.
    event MetacallSettled(
        address indexed solver,
        address indexed bidToken,
        uint256 bidAmount,
        uint256 bidReceivedByEE
    );

    /// @notice Thrown when, after the solver runs, the EE did not receive the committed bid.
    error BidNotPaid(uint256 received, uint256 expected);

    constructor() {
        executionEnvironment = address(this);
    }

    /// @notice Override the EE address (defaults to this contract) for tests that want a separate
    /// @notice EE sink. The bid receipt assertion uses whatever EE is set here.
    function setExecutionEnvironment(address ee) external {
        executionEnvironment = ee;
    }

    /// @notice Configure a native gas shortfall the solver should reconcile() this metacall.
    function setShortfall(uint256 amount) external {
        reportedShortfall = amount;
    }

    /// @inheritdoc IAtlasEscrow
    function shortfall() external view override returns (uint256) {
        return reportedShortfall;
    }

    /// @inheritdoc IAtlasEscrow
    /// @dev Accepts the solver's native repayment and records it. Returns remaining owed.
    function reconcile(uint256 maxApprovedGasSpend) external payable override returns (uint256 owed) {
        lastReconciled += msg.value;
        uint256 paid = maxApprovedGasSpend < msg.value ? maxApprovedGasSpend : msg.value;
        owed = reportedShortfall > paid ? reportedShortfall - paid : 0;
        reportedShortfall = owed;
        return owed;
    }

    /// @notice Drive one Atlas-style metacall: invoke the solver with a winning bid and assert the
    /// @notice Execution Environment received the committed bid afterward (the blind-bid invariant).
    /// @dev This is the entry tests call. It mirrors Atlas selecting the top bid and calling the
    /// @dev solver contract; the post-call bid-receipt check stands in for Atlas's ex-post
    /// @dev accounting. Any revert inside the solver bubbles up (metacall fails, nothing settled).
    /// @param solver The BofhAtlasSolver contract to invoke
    /// @param solverOpFrom The searcher EOA that signed the SolverOperation
    /// @param bidToken Token the bid is denominated in (must be the solver's base token here)
    /// @param bidAmount Amount of bidToken the solver committed to pay
    /// @param solverOpData The encoded Backrun (abi.encode of BofhAtlasSolver.Backrun)
    /// @return bidReceived How much bidToken the EE actually received from the solver
    function metacall(
        address solver,
        address solverOpFrom,
        address bidToken,
        uint256 bidAmount,
        bytes calldata solverOpData
    ) external returns (uint256 bidReceived) {
        address ee = executionEnvironment;
        eeBalanceBefore = IBEP20(bidToken).balanceOf(ee);

        // Invoke the solver exactly as Atlas would. Forward no native value on the happy path; a
        // shortfall test funds the solver directly and sets reportedShortfall.
        ISolverContract(solver).atlasSolverCall(
            solverOpFrom,
            ee,
            bidToken,
            bidAmount,
            solverOpData,
            bytes("") // extraReturnData (no prior phase output in the mock)
        );

        // Blind-bid invariant: the EE must have received exactly the committed bid.
        uint256 after_ = IBEP20(bidToken).balanceOf(ee);
        bidReceived = after_ - eeBalanceBefore;
        if (bidReceived < bidAmount) revert BidNotPaid(bidReceived, bidAmount);

        emit MetacallSettled(solver, bidToken, bidAmount, bidReceived);
        return bidReceived;
    }

    /// @notice Allow the mock EE to hold native value for reconcile flows.
    receive() external payable {}
}
