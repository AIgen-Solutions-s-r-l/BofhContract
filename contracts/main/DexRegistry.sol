// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.10;

import "../interfaces/IBofhContract.sol";

/// @title DexRegistry - On-chain registry of V2-fork DEXes for multi-DEX routing
/// @author Bofh Team
/// @notice Holds a per-DEX record of {factory, feeBps, enabled} so a single router
/// @notice deployment can route different hops through different Uniswap-V2-style
/// @notice forks (Pancake 0.25%, Uniswap/Quickswap/Sushi 0.3%, higher-fee forks).
/// @dev All target DEXes share the identical IGenericPair.swap ABI and x*y=k CPMM math,
/// @dev differing ONLY in a flat per-hop fee. The single thing that makes a hop route
/// @dev through Pancake vs Sushi is WHICH pair address swap() is called on, and that
/// @dev address is fully determined by (factory, tokenIn, tokenOut). So a {factory, feeBps}
/// @dev record per DEX is sufficient — no per-DEX code, no adapter delegation.
/// @dev This abstract contract holds the registry storage + admin surface so the already
/// @dev large BofhContractV2 does not grow it (respects the 500-line soft limit).
/// @custom:security _setDex is internal; the onlyOwner wrapper lives in BofhContractBase.
abstract contract DexRegistry {
    /// @notice Maximum allowed per-hop fee in basis points out of 10000 (10% = 1000 bps)
    /// @dev Relocated here from BofhContractV2 so both the registry feeBps validation and
    /// @dev the router's _validateSwapInputs reference one single definition.
    uint256 internal constant MAX_FEE_BPS = 1000;

    /// @notice Per-DEX record. Packs into a single storage slot (160 + 16 + 8 = 184 bits).
    /// @custom:field factory Uniswap-V2-style factory address used for getPair lookups
    /// @custom:field feeBps Flat per-hop fee in basis points out of 10000 (25 = 0.25%, 30 = 0.3%)
    /// @custom:field enabled Whether this DEX may be used to resolve a hop
    struct DexInfo {
        address factory;
        uint16 feeBps;
        bool enabled;
    }

    /// @notice dexId => DexInfo. dexId 0 is RESERVED for the router's immutable factory
    /// @notice and is NOT stored here (resolved specially by the router's _resolveDex override).
    mapping(uint16 => DexInfo) internal _dexRegistry;

    /// @notice Emitted when a DEX is registered/updated via setDex
    /// @param dexId Registry id (must be > 0)
    /// @param factory Factory address for this DEX
    /// @param feeBps Flat per-hop fee in basis points
    /// @param enabled Whether the DEX is enabled
    event DexRegistered(uint16 indexed dexId, address indexed factory, uint16 feeBps, bool enabled);

    /// @notice Thrown when resolving a dexId that is not registered or is disabled
    error DexNotRegistered(uint16 dexId);

    /// @notice Thrown when attempting to register dexId 0 (reserved for the immutable factory)
    error DexAlreadyReserved();

    /// @notice Thrown when registering a DEX with a zero factory address
    error InvalidDexFactory();

    // Fee-cap violations revert with IBofhContract.InvalidFee (same selector the router uses)
    // so callers/tests see a single InvalidFee error across the codebase. Referenced as a
    // qualified error below; IBofhContract is imported but NOT inherited (no interface coupling).

    /// @notice Register or update a DEX record (internal; gated by onlyOwner wrapper upstream)
    /// @dev Reverts DexAlreadyReserved if dexId==0, InvalidDexFactory if factory_==0,
    /// @dev InvalidFee if feeBps>MAX_FEE_BPS. Writes the packed struct and emits DexRegistered.
    /// @param dexId Registry id (must be > 0; 0 is the reserved immutable factory)
    /// @param factory_ Uniswap-V2-style factory for this DEX (must be non-zero)
    /// @param feeBps Flat per-hop fee in basis points (<= MAX_FEE_BPS)
    /// @param enabled Whether the DEX may be used immediately
    function _setDex(uint16 dexId, address factory_, uint16 feeBps, bool enabled) internal {
        if (dexId == 0) revert DexAlreadyReserved();
        if (factory_ == address(0)) revert InvalidDexFactory();
        if (uint256(feeBps) > MAX_FEE_BPS) revert IBofhContract.InvalidFee();

        _dexRegistry[dexId] = DexInfo({factory: factory_, feeBps: feeBps, enabled: enabled});
        emit DexRegistered(dexId, factory_, feeBps, enabled);
    }

    /// @notice Resolve a dexId to its (factory, feeBps); must be overridden where the
    /// @notice router's immutable factory is visible so dexId 0 can be special-cased.
    /// @dev Base implementation reverts: the derived router overrides this to handle dexId 0.
    /// @param dexId Registry id to resolve
    /// @return factory_ Factory address for the resolved DEX
    /// @return feeBps Flat per-hop fee for the resolved DEX
    function _resolveDex(uint16 dexId) internal view virtual returns (address factory_, uint16 feeBps);

    /// @notice Read a registered DEX record
    /// @param dexId Registry id to read (use 0 only via the router's resolver, not here)
    /// @return factory Factory address (address(0) if unregistered)
    /// @return feeBps Flat per-hop fee in basis points
    /// @return enabled Whether the DEX is enabled
    function getDex(uint16 dexId) external view returns (address factory, uint16 feeBps, bool enabled) {
        DexInfo storage d = _dexRegistry[dexId];
        return (d.factory, d.feeBps, d.enabled);
    }
}
