// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.10;

/// @title SecurityLib - Comprehensive Security and Access Control Library
/// @author Bofh Team
/// @notice Provides reentrancy protection, access control, rate limiting, and emergency controls
/// @dev Implements stateful security primitives with gas-optimized custom errors
/// @custom:security All functions validate caller permissions and state before execution
library SecurityLib {
    /// @notice Thrown when caller lacks required permissions (owner or operator)
    error Unauthorized();

    /// @notice Thrown when reentrancy is detected or cooldown period not elapsed
    error ReentrancyGuardError();

    /// @notice Thrown when contract is in paused state
    error ContractPaused();

    /// @notice Thrown when deadline has expired (with grace period if applicable)
    error DeadlineExpired();

    /// @notice Thrown when address is zero or invalid (e.g., no bytecode when required)
    error InvalidAddress();

    /// @notice Thrown when value exceeds bounds or rate limits
    error ExcessiveValue();

    /// @notice Thrown when contract is locked (reentrancy guard active)
    error ContractLocked();

    /// @notice Complete security state for a contract
    /// @dev Contains ownership, pause state, reentrancy lock, and rate limiting data
    /// @dev Storage optimized: owner (20 bytes) + paused (1 byte) + locked (1 byte) = 22 bytes in slot 0
    /// @custom:field owner Contract owner address with full permissions (20 bytes)
    /// @custom:field paused Emergency pause state (when true, most functions revert) (1 byte, packed)
    /// @custom:field locked Reentrancy guard lock (true when function is executing) (1 byte, packed)
    /// @custom:field pendingOwner Address nominated by transferOwnership; must call acceptOwnership
    /// @custom:field lastActionTimestamp Last action timestamp for cooldown/rate limiting (32 bytes, slot 1)
    /// @custom:field globalActionCounter Total actions in current interval (32 bytes, slot 2)
    /// @custom:field operators Mapping of authorized operator addresses (separate slots)
    /// @custom:field functionCooldowns Per-function cooldown periods (seconds) (separate slots)
    /// @custom:field userActionCounts Per-user action counter for rate limiting (separate slots)
    struct SecurityState {
        address owner;              // Slot 0: bytes 0-19 (20 bytes)
        bool paused;                // Slot 0: byte 20 (1 byte, packed with owner)
        bool locked;                // Slot 0: byte 21 (1 byte, packed with owner and paused)
        address pendingOwner;       // Slot 1: bytes 0-19 (two-step ownership handoff target)
        uint256 lastActionTimestamp;    // Slot 2: full slot (32 bytes)
        uint256 globalActionCounter;    // Slot 3: full slot (32 bytes)
        mapping(address => bool) operators;            // Slot 4+: mappings always separate
        mapping(bytes4 => uint256) functionCooldowns;  // Slot N+: mappings always separate
        mapping(address => uint256) userActionCounts;  // Slot M+: mappings always separate
    }

    /// @notice Emitted when ownership of the contract is completed (acceptOwnership)
    /// @param previousOwner Address of the previous owner
    /// @param newOwner Address of the new owner
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /// @notice Emitted when an ownership transfer is initiated (transferOwnership)
    /// @dev Step 1 of the two-step (Ownable2Step) handoff; the nominee must call acceptOwnership
    /// @param previousOwner Current owner that initiated the transfer
    /// @param newOwner Nominated owner that must accept to take control
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    /// @notice Emitted when operator status is changed
    /// @param operator Address of the operator
    /// @param status New operator status (true = authorized, false = revoked)
    event OperatorStatusChanged(address indexed operator, bool status);

    /// @notice Emitted when security state changes (pause/lock)
    /// @param paused New pause state
    /// @param locked New lock state
    event SecurityStateChanged(bool paused, bool locked);

    /// @notice Emitted when suspicious activity is detected
    /// @param user Address of the user triggering anomaly
    /// @param selector Function selector that triggered detection
    /// @param reason Human-readable reason for anomaly detection
    event AnomalyDetected(address indexed user, bytes4 indexed selector, string reason);

    /// @notice Verify caller is contract owner
    /// @dev Reverts with Unauthorized() if msg.sender != owner
    /// @param self Security state containing owner address
    /// @custom:security Use at start of owner-only functions
    function checkOwner(SecurityState storage self) internal view {
        if (msg.sender != self.owner) revert Unauthorized();
    }

    /// @notice Verify caller is owner or authorized operator
    /// @dev Reverts with Unauthorized() if msg.sender is neither owner nor operator
    /// @param self Security state containing owner and operators mapping
    /// @custom:security Use for functions requiring elevated permissions
    function checkOperator(SecurityState storage self) internal view {
        if (!self.operators[msg.sender] && msg.sender != self.owner) revert Unauthorized();
    }

    /// @notice Verify contract is not paused
    /// @dev Reverts with ContractPaused() if self.paused == true
    /// @param self Security state containing pause flag
    /// @custom:security Use in all normal operation functions (exclude emergency functions)
    function checkNotPaused(SecurityState storage self) internal view {
        if (self.paused) revert ContractPaused();
    }

    /// @notice Verify contract is not locked (no active reentrancy guard)
    /// @dev Reverts with ContractLocked() if self.locked == true
    /// @param self Security state containing lock flag
    /// @custom:security Used internally by enterProtectedSection
    function checkNotLocked(SecurityState storage self) internal view {
        if (self.locked) revert ContractLocked();
    }

    /// @notice Enter reentrancy-protected section with optional per-function cooldown
    /// @dev Sets lock flag and validates cooldown period for the given function selector
    /// @dev Must be called at start of protected function, paired with exitProtectedSection
    /// @param self Security state to lock
    /// @param selector Function selector (msg.sig) for cooldown lookup
    /// @custom:security Prevents reentrancy attacks and enforces function-specific rate limits
    /// @custom:security Reverts with ReentrancyGuardError if: 1) already locked, or 2) cooldown not elapsed
    /// @custom:example Call at function start: SecurityLib.enterProtectedSection(security, msg.sig);
    function enterProtectedSection(
        SecurityState storage self,
        bytes4 selector
    ) internal {
        if (self.locked) revert ReentrancyGuardError();

        uint256 cooldown = self.functionCooldowns[selector];
        if (cooldown > 0 && block.timestamp - self.lastActionTimestamp < cooldown) {
            revert ReentrancyGuardError();
        }

        self.locked = true;
        self.lastActionTimestamp = block.timestamp;
    }

    /// @notice Exit reentrancy-protected section by releasing lock
    /// @dev Clears lock flag to allow subsequent protected calls
    /// @dev Must be called before every return/revert in protected functions
    /// @param self Security state to unlock
    /// @custom:security Always call this before function returns to prevent permanent lock
    /// @custom:example Call before return: SecurityLib.exitProtectedSection(security);
    function exitProtectedSection(SecurityState storage self) internal {
        self.locked = false;
    }

    /// @notice Start a two-step ownership transfer by nominating a new owner (Ownable2Step)
    /// @dev Step 1: only the current owner may nominate. Ownership does NOT change here; the nominee
    /// @dev must call acceptOwnership to take control. This prevents accidentally handing the contract
    /// @dev to a wrong/uncontrolled address (the classic single-step transferOwnership footgun).
    /// @param self Security state containing current owner
    /// @param newOwner Address nominated as the next owner (must not be address(0))
    /// @custom:security Validates caller is current owner and newOwner != address(0)
    /// @custom:security Emits OwnershipTransferStarted; OwnershipTransferred fires only on acceptOwnership
    function transferOwnership(
        SecurityState storage self,
        address newOwner
    ) internal {
        if (msg.sender != self.owner) revert Unauthorized();
        if (newOwner == address(0)) revert InvalidAddress();

        self.pendingOwner = newOwner;
        emit OwnershipTransferStarted(self.owner, newOwner);
    }

    /// @notice Complete a two-step ownership transfer (Ownable2Step)
    /// @dev Step 2: only the address nominated by transferOwnership may accept. Promotes the
    /// @dev pendingOwner to owner and clears the nomination. Any address that is not the current
    /// @dev pendingOwner (including a non-pending account or address(0) before any nomination) reverts.
    /// @param self Security state containing current owner and pendingOwner
    /// @custom:security Reverts Unauthorized if msg.sender != pendingOwner
    /// @custom:security Emits OwnershipTransferred for off-chain tracking
    function acceptOwnership(SecurityState storage self) internal {
        if (msg.sender != self.pendingOwner) revert Unauthorized();

        address oldOwner = self.owner;
        self.owner = self.pendingOwner;
        self.pendingOwner = address(0);
        emit OwnershipTransferred(oldOwner, self.owner);
    }

    /// @notice Grant or revoke operator status for an address
    /// @dev Only callable by owner, operators have elevated permissions below owner
    /// @param self Security state containing operators mapping
    /// @param operator Address to grant/revoke operator status
    /// @param status True to grant operator role, false to revoke
    /// @custom:security Validates caller is owner and operator != address(0)
    /// @custom:security Emits OperatorStatusChanged event for off-chain tracking
    function setOperator(
        SecurityState storage self,
        address operator,
        bool status
    ) internal {
        if (msg.sender != self.owner) revert Unauthorized();
        if (operator == address(0)) revert InvalidAddress();

        self.operators[operator] = status;
        emit OperatorStatusChanged(operator, status);
    }

    /// @notice Pause contract operations in emergency situations
    /// @dev Only callable by owner, sets paused flag to true
    /// @param self Security state to update
    /// @custom:security Blocks all functions using checkNotPaused modifier
    /// @custom:security Emits SecurityStateChanged event
    /// @custom:example Use when: exploit detected, critical bug found, oracle compromise
    function emergencyPause(SecurityState storage self) internal {
        if (msg.sender != self.owner) revert Unauthorized();
        self.paused = true;
        emit SecurityStateChanged(true, self.locked);
    }

    /// @notice Resume contract operations after emergency is resolved
    /// @dev Only callable by owner, sets paused flag to false
    /// @param self Security state to update
    /// @custom:security Allows functions with checkNotPaused to execute again
    /// @custom:security Emits SecurityStateChanged event
    function emergencyUnpause(SecurityState storage self) internal {
        if (msg.sender != self.owner) revert Unauthorized();
        self.paused = false;
        emit SecurityStateChanged(false, self.locked);
    }

    /// @notice Enforce per-user rate limits with automatic interval resets
    /// @dev Tracks user action counts and resets after interval elapses
    /// @dev Emits AnomalyDetected event and reverts if limit exceeded
    /// @param self Security state containing action counters
    /// @param user Address to check rate limit for
    /// @param maxActionsPerInterval Maximum allowed actions per interval
    /// @param interval Time window in seconds for rate limiting
    /// @custom:security Prevents spam, flash loan attacks, and MEV manipulation
    /// @custom:security Automatically resets counters after interval passes
    function checkRateLimit(
        SecurityState storage self,
        address user,
        uint256 maxActionsPerInterval,
        uint256 interval
    ) internal {
        uint256 currentTime = block.timestamp;
        if (currentTime - self.lastActionTimestamp >= interval) {
            // Reset counters after interval
            self.userActionCounts[user] = 0;
            self.globalActionCounter = 0;
            self.lastActionTimestamp = currentTime;
        }

        // Check user-specific limit
        if (self.userActionCounts[user] >= maxActionsPerInterval) {
            emit AnomalyDetected(user, msg.sig, "Rate limit exceeded");
            revert ExcessiveValue();
        }

        // Update counters
        self.userActionCounts[user]++;
        self.globalActionCounter++;
    }

    /// @notice Configure per-function cooldown period
    /// @dev Only callable by owner, sets minimum delay between calls to a specific function
    /// @param self Security state containing cooldown mappings
    /// @param selector Function selector (bytes4) to configure cooldown for
    /// @param cooldownPeriod Minimum seconds required between calls (0 = no cooldown)
    /// @custom:security Used to prevent rapid-fire attacks on sensitive functions
    /// @custom:example setFunctionCooldown(security, this.executeSwap.selector, 60); // 60s cooldown
    function setFunctionCooldown(
        SecurityState storage self,
        bytes4 selector,
        uint256 cooldownPeriod
    ) internal {
        if (msg.sender != self.owner) revert Unauthorized();
        self.functionCooldowns[selector] = cooldownPeriod;
    }

    /// @notice Validate deadline with optional grace period
    /// @dev Reverts if current time exceeds deadline + grace period
    /// @param deadline Transaction deadline (Unix timestamp)
    /// @param gracePeriod Additional seconds allowed after deadline (0 = strict)
    /// @custom:security Prevents execution of stale transactions
    /// @custom:example validateDeadline(deadline, 0); // Strict deadline check
    function validateDeadline(
        uint256 deadline,
        uint256 gracePeriod
    ) internal view {
        if (block.timestamp > deadline + gracePeriod) {
            revert DeadlineExpired();
        }
    }

    /// @notice Validate value is within specified bounds
    /// @dev Reverts with ExcessiveValue if value < minValue or value > maxValue
    /// @param value Value to check
    /// @param minValue Minimum allowed value (inclusive)
    /// @param maxValue Maximum allowed value (inclusive)
    /// @custom:security Use for validating user inputs, amounts, and percentages
    function checkValueBounds(
        uint256 value,
        uint256 minValue,
        uint256 maxValue
    ) internal pure {
        if (value < minValue || value > maxValue) {
            revert ExcessiveValue();
        }
    }

    /// @notice Validate address is not zero and has deployed bytecode
    /// @dev Reverts with InvalidAddress if addr == address(0) or no contract code
    /// @param addr Address to validate
    /// @custom:security Ensures address points to a deployed contract
    /// @custom:example validateAddress(tokenAddress); // Ensures token contract exists
    function validateAddress(address addr) internal view {
        if (addr == address(0) || addr.code.length == 0) {
            revert InvalidAddress();
        }
    }

    /// @notice Ensure address is an EOA (externally owned account), not a contract
    /// @dev Reverts with InvalidAddress if addr has bytecode (is a contract)
    /// @param addr Address to check
    /// @custom:security Use to prevent contract-based attacks or enforce EOA-only functions
    /// @custom:example ensureNotContract(msg.sender); // Only allow EOA callers
    function ensureNotContract(address addr) internal view {
        if (addr.code.length > 0) {
            revert InvalidAddress();
        }
    }
}