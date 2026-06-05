// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.10;

import "../interfaces/ISwapInterfaces.sol";
import "../libs/SwapMathLib.sol";

/// @title MockSolverExecutor - a controllable executor stand-in for BofhAtlasSolver unit tests
/// @author Bofh Team
/// @notice Implements ONLY the {executeSwapMultiDex} surface BofhAtlasSolver drives, but returns a
/// @notice caller-configured `grossOut` instead of running a real round-trip. This lets a test
/// @notice DECOUPLE the solver's own profit guard from the real executor's `minAmountOut` backstop:
/// @notice the solver forces `enforcedMin = max(minAmountOut, amountIn + bidAmount)`, so the REAL
/// @notice BofhContractV2 would revert `InsufficientOutput` before the solver's `BidNotCovered`
/// @notice branch could ever run. By IGNORING minAmountOut here and handing back an arbitrary
/// @notice `grossOut`, the mock makes the solver-level checks (`grossOut < amountIn` and
/// @notice `profit < bidAmount`) reachable and individually exercisable.
/// @dev Token flow mirrors the real executor's non-custodial contract: it pulls exactly `amountIn`
/// @dev of base from the caller (the solver, which approved it) and then transfers `grossOut` base
/// @dev back to the caller — the same net movement the solver observes from BofhContractV2.
/// @dev TEST-ONLY. Never deployed to a live network.
contract MockSolverExecutor {
    /// @notice Base token this mock pulls and returns (matches the solver's baseToken).
    address public base;

    /// @notice The exact output the next {executeSwapMultiDex} hands back, regardless of minAmountOut.
    uint256 public nextGrossOut;

    /// @notice When true, the mock honors `minAmountOut` (reverts if grossOut < min) like the real
    /// @notice executor; when false (default) it ignores it so the solver-level guards are isolated.
    bool public enforceMin;

    error InsufficientOutput();

    constructor(address base_) {
        base = base_;
    }

    /// @notice Set the gross output the next call returns to the solver.
    function setNextGrossOut(uint256 grossOut_) external {
        nextGrossOut = grossOut_;
    }

    /// @notice Toggle whether the mock enforces minAmountOut (default false to isolate solver checks).
    function setEnforceMin(bool on) external {
        enforceMin = on;
    }

    /// @notice Same selector/signature as BofhContractV2.executeSwapMultiDex.
    /// @dev Pulls `amountIn` base from msg.sender (the solver, which approved this contract), then
    /// @dev sends back the pre-configured `nextGrossOut` base. The path/fees/dexIds are ignored.
    function executeSwapMultiDex(
        address[] calldata /* path */,
        uint256[] calldata /* fees */,
        uint16[] calldata /* dexIds */,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 /* deadline */
    ) external returns (uint256) {
        uint256 grossOut = nextGrossOut;
        if (enforceMin && grossOut < minAmountOut) revert InsufficientOutput();

        // Pull the principal exactly as the real executor does (solver approved amountIn). Uses the
        // same tolerant safe-transfer helper as BofhContractV2 so non-standard (no-return) base
        // tokens behave identically here.
        SwapMathLib.safeTransferFrom(base, msg.sender, address(this), amountIn);

        // Hand the configured round-trip output back to the solver (caller).
        SwapMathLib.safeTransfer(base, msg.sender, grossOut);
        return grossOut;
    }

    /// @notice Let tests seed this mock with base liquidity so it can return grossOut > amountIn.
    receive() external payable {}
}
