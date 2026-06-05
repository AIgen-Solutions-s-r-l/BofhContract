// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.10;

import "../libs/PoolLib.sol";

/**
 * @title PoolLibTest
 * @dev Test wrapper contract to expose PoolLib functions for testing
 */
contract PoolLibTest {
    function testCalculatePriceImpact(
        uint256 amountIn,
        PoolLib.PoolState memory pool
    ) external pure returns (uint256) {
        return PoolLib.calculatePriceImpact(amountIn, pool);
    }

    function testCalculateVolatility(
        PoolLib.PoolState memory pool,
        uint256 lastTimestamp,
        uint256 currentTimestamp
    ) external pure returns (uint256) {
        return PoolLib.calculateVolatility(pool, lastTimestamp, currentTimestamp);
    }

    function testAnalyzePool(
        address pool,
        address tokenIn,
        uint256 amountIn,
        uint256 timestamp
    ) external view returns (PoolLib.PoolState memory) {
        return PoolLib.analyzePool(pool, tokenIn, amountIn, timestamp);
    }

    function testValidateSwap(
        PoolLib.PoolState memory pool,
        PoolLib.SwapParams memory params
    ) external view returns (bool) {
        return PoolLib.validateSwap(pool, params);
    }
}
