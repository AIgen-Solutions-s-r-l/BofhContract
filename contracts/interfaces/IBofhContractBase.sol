// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.10;

/// @title IBofhContractBase
/// @notice Interface for BofhContractBase - Security, Risk Management, and MEV Protection
/// @dev Defines administrative functions, risk parameters, and security controls
/// @custom:security All admin functions must implement access control via onlyOwner
interface IBofhContractBase {
    // ============================================
    // EVENTS
    // ============================================

    /// @notice Emitted when pool blacklist status changes
    /// @param pool Address of the pool
    /// @param blacklisted New blacklist status (true = blacklisted, false = whitelisted)
    event PoolBlacklisted(address indexed pool, bool blacklisted);

    /// @notice Emitted when risk management parameters are updated
    /// @param maxVolume New maximum trade volume
    /// @param minLiquidity New minimum pool liquidity
    /// @param maxImpact New maximum price impact
    /// @param sandwichProtection New sandwich protection in basis points
    event RiskParamsUpdated(
        uint256 maxVolume,
        uint256 minLiquidity,
        uint256 maxImpact,
        uint256 sandwichProtection
    );

    /// @notice Emitted when MEV protection configuration is updated
    /// @param enabled New enabled status
    /// @param maxTxPerBlock New maximum transactions per block
    /// @param minTxDelay New minimum delay between transactions
    event MEVProtectionUpdated(bool enabled, uint256 maxTxPerBlock, uint256 minTxDelay);

    /// @notice Emitted when tokens are recovered from the contract
    /// @param token Address of the recovered token
    /// @param to Recipient address
    /// @param amount Amount of tokens recovered
    /// @param recoveredBy Address that initiated the recovery (owner)
    event EmergencyTokenRecovery(
        address indexed token,
        address indexed to,
        uint256 amount,
        address indexed recoveredBy
    );

    // ============================================
    // ERRORS
    // ============================================

    /// @notice Thrown when flash loan attack is detected (too many transactions per block)
    error FlashLoanDetected();

    /// @notice Thrown when user exceeds transaction rate limit (transactions too frequent)
    error RateLimitExceeded();

    // ============================================
    // ADMIN FUNCTIONS
    // ============================================

    /// @notice Update risk management parameters
    /// @dev Only callable by owner, validates maxPriceImpact ≤ 10% and sandwichProtection ≤ 1%
    /// @param _maxTradeVolume New maximum trade volume per swap
    /// @param _minPoolLiquidity New minimum required pool liquidity
    /// @param _maxPriceImpact New maximum allowed price impact (max 10%)
    /// @param _sandwichProtectionBips New sandwich protection in basis points (max 100 = 1%)
    function updateRiskParams(
        uint256 _maxTradeVolume,
        uint256 _minPoolLiquidity,
        uint256 _maxPriceImpact,
        uint256 _sandwichProtectionBips
    ) external;

    /// @notice Blacklist or whitelist a specific pool address
    /// @dev Only callable by owner, prevents swaps through blacklisted pools
    /// @param pool Address of the pool to blacklist/whitelist
    /// @param blacklisted True to blacklist (block swaps), false to whitelist (allow swaps)
    function setPoolBlacklist(address pool, bool blacklisted) external;

    /// @notice Configure MEV protection parameters
    /// @dev Only callable by owner
    /// @param enabled Enable or disable MEV protection
    /// @param _maxTxPerBlock Maximum transactions per block per address (flash loan detection)
    /// @param _minTxDelay Minimum seconds between transactions per address (rate limiting)
    function configureMEVProtection(
        bool enabled,
        uint256 _maxTxPerBlock,
        uint256 _minTxDelay
    ) external;

    /// @notice Pause all contract operations in emergency situations
    /// @dev Only callable by owner, blocks all functions with whenNotPaused modifier
    function emergencyPause() external;

    /// @notice Resume contract operations after emergency is resolved
    /// @dev Only callable by owner, allows functions with whenNotPaused to execute
    function emergencyUnpause() external;

    /// @notice Transfer contract ownership to a new address
    /// @dev Only callable by current owner
    /// @param newOwner Address of new owner (must not be address(0))
    function transferOwnership(address newOwner) external;

    /// @notice Grant or revoke operator status for an address
    /// @dev Only callable by owner
    /// @param operator Address to grant/revoke operator status
    /// @param status True to grant operator role, false to revoke
    function setOperator(address operator, bool status) external;

    /// @notice Recover ERC20 tokens accidentally sent to the contract
    /// @dev Only callable by owner when contract is paused (emergency state)
    /// @dev Provides mechanism to rescue tokens sent by mistake or stuck due to failed swaps
    /// @param token Address of ERC20 token to recover
    /// @param to Recipient address (where recovered tokens will be sent)
    /// @param amount Amount of tokens to recover
    function emergencyTokenRecovery(
        address token,
        address to,
        uint256 amount
    ) external;

    // ============================================
    // VIEW FUNCTIONS
    // ============================================

    /// @notice Get the contract administrator address
    /// @return The address of the contract owner
    function getAdmin() external view returns (address);

    /// @notice Get all risk management parameters
    /// @return maxVolume Maximum trade volume allowed
    /// @return minLiquidity Minimum pool liquidity required
    /// @return maxImpact Maximum price impact allowed (in PRECISION units)
    /// @return sandwichProtection Sandwich attack protection in basis points
    function getRiskParameters()
        external
        view
        returns (
            uint256 maxVolume,
            uint256 minLiquidity,
            uint256 maxImpact,
            uint256 sandwichProtection
        );

    /// @notice Check if a pool is blacklisted
    /// @param pool The address of the pool to check
    /// @return True if the pool is blacklisted, false otherwise
    function isPoolBlacklisted(address pool) external view returns (bool);

    /// @notice Check if the contract is currently paused
    /// @return True if paused, false if active
    function isPaused() external view returns (bool);

    /// @notice Get MEV protection configuration
    /// @return enabled Whether MEV protection is enabled
    /// @return maxTx Maximum transactions per block
    /// @return minDelay Minimum delay between transactions in seconds
    function getMEVProtectionConfig()
        external
        view
        returns (
            bool enabled,
            uint256 maxTx,
            uint256 minDelay
        );

    /// @notice Get blacklisted pools mapping
    /// @param pool Pool address to check
    /// @return blacklisted True if pool is blacklisted
    function blacklistedPools(address pool) external view returns (bool blacklisted);

    /// @notice Get maximum trade volume parameter
    /// @return Maximum allowed trade volume
    function maxTradeVolume() external view returns (uint256);

    /// @notice Get minimum pool liquidity parameter
    /// @return Minimum required pool liquidity
    function minPoolLiquidity() external view returns (uint256);

    /// @notice Get maximum price impact parameter
    /// @return Maximum allowed price impact
    function maxPriceImpact() external view returns (uint256);

    /// @notice Get sandwich protection parameter
    /// @return Sandwich protection in basis points
    function sandwichProtectionBips() external view returns (uint256);

    /// @notice Get MEV protection enabled flag
    /// @return True if MEV protection is enabled
    function mevProtectionEnabled() external view returns (bool);

    /// @notice Get maximum transactions per block limit
    /// @return Maximum transactions per block per user
    function maxTxPerBlock() external view returns (uint256);

    /// @notice Get minimum transaction delay
    /// @return Minimum delay between transactions in seconds
    function minTxDelay() external view returns (uint256);
}
