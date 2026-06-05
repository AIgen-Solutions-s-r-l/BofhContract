// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.10;

import "./MockToken.sol";

contract MockPair {
    address public token0;
    address public token1;
    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;
    
    uint256 private constant MINIMUM_LIQUIDITY = 1000;
    uint256 private constant FEE_DENOMINATOR = 10000;
    uint256 public swapFee = 30; // 0.3% (30/10000); set via setSwapFee for other DEX fees
    
    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);
    
    constructor(address token0_, address token1_) {
        require(token0_ != address(0) && token1_ != address(0), "Invalid token address");
        require(token0_ != token1_, "Identical addresses");
        
        // Sort tokens
        (token0, token1) = token0_ < token1_ 
            ? (token0_, token1_) 
            : (token1_, token0_);
    }
    
    function getReserves() public view returns (
        uint112 _reserve0,
        uint112 _reserve1,
        uint32 _blockTimestampLast
    ) {
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = blockTimestampLast;
    }

    /// @notice Set the swap fee in basis points out of FEE_DENOMINATOR (10000)
    /// @dev Test helper to emulate DEXes with different fees (25 = 0.25%, 30 = 0.3%, 50 = 0.5%)
    /// @param _fee Fee in basis points out of 10000
    function setSwapFee(uint256 _fee) external {
        swapFee = _fee;
    }

    function mint(address to) external returns (uint256 liquidity) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        uint256 balance0 = MockToken(token0).balanceOf(address(this));
        uint256 balance1 = MockToken(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - _reserve0;
        uint256 amount1 = balance1 - _reserve1;
        
        uint256 _totalSupply = totalSupply;
        if (_totalSupply == 0) {
            liquidity = Math.sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            _mint(address(0), MINIMUM_LIQUIDITY); // Permanently lock the first MINIMUM_LIQUIDITY tokens
        } else {
            liquidity = Math.min(
                (amount0 * _totalSupply) / _reserve0,
                (amount1 * _totalSupply) / _reserve1
            );
        }
        
        require(liquidity > 0, "Insufficient liquidity minted");
        _mint(to, liquidity);
        
        _update(balance0, balance1, _reserve0, _reserve1);
        emit Mint(msg.sender, amount0, amount1);
    }
    
    function burn(address to) external returns (uint256 amount0, uint256 amount1) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        uint256 balance0 = MockToken(token0).balanceOf(address(this));
        uint256 balance1 = MockToken(token1).balanceOf(address(this));
        uint256 liquidity = balanceOf[address(this)];
        
        uint256 _totalSupply = totalSupply;
        amount0 = (liquidity * balance0) / _totalSupply;
        amount1 = (liquidity * balance1) / _totalSupply;
        require(amount0 > 0 && amount1 > 0, "Insufficient liquidity burned");
        
        _burn(address(this), liquidity);
        MockToken(token0).transfer(to, amount0);
        MockToken(token1).transfer(to, amount1);
        balance0 = MockToken(token0).balanceOf(address(this));
        balance1 = MockToken(token1).balanceOf(address(this));
        
        _update(balance0, balance1, _reserve0, _reserve1);
        emit Burn(msg.sender, amount0, amount1, to);
    }
    
    function swap(
        uint256 amount0Out,
        uint256 amount1Out,
        address to,
        bytes calldata data
    ) external {
        require(amount0Out > 0 || amount1Out > 0, "Insufficient output amount");
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        require(amount0Out < _reserve0 && amount1Out < _reserve1, "Insufficient liquidity");
        
        uint256 balance0;
        uint256 balance1;
        {
            require(to != token0 && to != token1, "Invalid to");
            if (amount0Out > 0) MockToken(token0).transfer(to, amount0Out);
            if (amount1Out > 0) MockToken(token1).transfer(to, amount1Out);
            if (data.length > 0) IUniswapV2Callee(to).uniswapV2Call(msg.sender, amount0Out, amount1Out, data);
            balance0 = MockToken(token0).balanceOf(address(this));
            balance1 = MockToken(token1).balanceOf(address(this));
        }
        
        uint256 amount0In = balance0 > _reserve0 - amount0Out ? balance0 - (_reserve0 - amount0Out) : 0;
        uint256 amount1In = balance1 > _reserve1 - amount1Out ? balance1 - (_reserve1 - amount1Out) : 0;
        require(amount0In > 0 || amount1In > 0, "Insufficient input amount");
        
        {
            uint256 balance0Adjusted = balance0 * FEE_DENOMINATOR - (amount0In * swapFee);
            uint256 balance1Adjusted = balance1 * FEE_DENOMINATOR - (amount1In * swapFee);
            require(
                balance0Adjusted * balance1Adjusted >= uint256(_reserve0) * uint256(_reserve1) * (FEE_DENOMINATOR**2),
                "K"
            );
        }
        
        _update(balance0, balance1, _reserve0, _reserve1);
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }
    
    function sync() external {
        _update(
            MockToken(token0).balanceOf(address(this)),
            MockToken(token1).balanceOf(address(this)),
            reserve0,
            reserve1
        );
    }
    
    function _update(
        uint256 balance0,
        uint256 balance1,
        uint112 _reserve0,
        uint112 _reserve1
    ) private {
        require(balance0 <= type(uint112).max && balance1 <= type(uint112).max, "Overflow");
        uint32 blockTimestamp = uint32(block.timestamp % 2**32);
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        blockTimestampLast = blockTimestamp;
        emit Sync(reserve0, reserve1);
    }
    
    // Placeholder functions for LP token functionality
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    
    function _mint(address to, uint256 value) private {
        totalSupply += value;
        balanceOf[to] += value;
    }
    
    function _burn(address from, uint256 value) private {
        balanceOf[from] -= value;
        totalSupply -= value;
    }
}

interface IUniswapV2Callee {
    function uniswapV2Call(address, uint256, uint256, bytes calldata) external;
}

library Math {
    function min(uint256 x, uint256 y) internal pure returns (uint256 z) {
        z = x < y ? x : y;
    }
    
    function sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}