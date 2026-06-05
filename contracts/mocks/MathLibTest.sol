// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.10;

import "../libs/MathLib.sol";

/**
 * @title MathLibTest
 * @dev Test wrapper contract to expose MathLib functions for testing
 */
contract MathLibTest {
    function testSqrt(uint256 x) external pure returns (uint256) {
        return MathLib.sqrt(x);
    }

    function testCbrt(uint256 x) external pure returns (uint256) {
        return MathLib.cbrt(x);
    }

    function testLog2(uint256 x) external pure returns (uint256) {
        return MathLib.log2(x);
    }

    function testExp2(uint256 x) external pure returns (uint256) {
        return MathLib.exp2(x);
    }
}
