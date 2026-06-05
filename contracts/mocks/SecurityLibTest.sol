// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.10;

import "../libs/SecurityLib.sol";

/**
 * @title SecurityLibTest
 * @dev Test wrapper contract to expose SecurityLib functions for testing
 */
contract SecurityLibTest {
    using SecurityLib for SecurityLib.SecurityState;

    SecurityLib.SecurityState private securityState;

    // Events (re-declared for testing)
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OperatorStatusChanged(address indexed operator, bool status);
    event SecurityStateChanged(bool paused, bool locked);
    event AnomalyDetected(address indexed user, bytes4 indexed selector, string reason);

    constructor() {
        securityState.owner = msg.sender;
        securityState.paused = false;
        securityState.locked = false;
    }

    function testCheckOwner() external view {
        securityState.checkOwner();
    }

    function testCheckOperator() external view {
        securityState.checkOperator();
    }

    function testCheckNotPaused() external view {
        securityState.checkNotPaused();
    }

    function testCheckNotLocked() external view {
        securityState.checkNotLocked();
    }

    function testEnterProtectedSection() external {
        securityState.enterProtectedSection(msg.sig);
    }

    function testExitProtectedSection() external {
        securityState.exitProtectedSection();
    }

    function testTransferOwnership(address newOwner) external {
        securityState.transferOwnership(newOwner);
    }

    function testAcceptOwnership() external {
        securityState.acceptOwnership();
    }

    function testSetOperator(address operator, bool status) external {
        securityState.setOperator(operator, status);
    }

    function testEmergencyPause() external {
        securityState.emergencyPause();
    }

    function testEmergencyUnpause() external {
        securityState.emergencyUnpause();
    }

    function testCheckRateLimit(
        uint256 maxActionsPerInterval,
        uint256 interval
    ) external {
        securityState.checkRateLimit(msg.sender, maxActionsPerInterval, interval);
    }

    function testSetFunctionCooldown(bytes4 selector, uint256 cooldownPeriod) external {
        securityState.setFunctionCooldown(selector, cooldownPeriod);
    }

    function testValidateDeadline(uint256 deadline, uint256 gracePeriod) external view {
        SecurityLib.validateDeadline(deadline, gracePeriod);
    }

    function testCheckValueBounds(
        uint256 value,
        uint256 minValue,
        uint256 maxValue
    ) external pure {
        SecurityLib.checkValueBounds(value, minValue, maxValue);
    }

    function testValidateAddress(address addr) external view {
        SecurityLib.validateAddress(addr);
    }

    function testEnsureNotContract(address addr) external view {
        SecurityLib.ensureNotContract(addr);
    }

    // Getters for testing state
    function getOwner() external view returns (address) {
        return securityState.owner;
    }

    function getPendingOwner() external view returns (address) {
        return securityState.pendingOwner;
    }

    function isPaused() external view returns (bool) {
        return securityState.paused;
    }

    function isLocked() external view returns (bool) {
        return securityState.locked;
    }
}
