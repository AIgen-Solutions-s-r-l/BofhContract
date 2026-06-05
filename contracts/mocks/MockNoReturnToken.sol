// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.10;

/// @title MockNoReturnToken - USDT/BSC-USD-style ERC20 whose transfer/transferFrom return NO data
/// @notice Models the non-standard token class (e.g. BSC-USD) where transfer/transferFrom are
/// @notice declared without a bool return value and write zero return data. A naive
/// @notice `require(token.transfer(...))` reverts against such tokens; SwapMathLib.safeTransfer
/// @notice handles them by checking call success and returndatasize() == 0.
/// @dev Used by the emergencyTokenRecovery regression test to prove non-standard tokens are
/// @dev recoverable rather than permanently locked.
contract MockNoReturnToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) private balances;
    mapping(address => mapping(address => uint256)) private allowances;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 initialSupply_
    ) {
        name = name_;
        symbol = symbol_;
        totalSupply = initialSupply_;
        balances[msg.sender] = initialSupply_;
        emit Transfer(address(0), msg.sender, initialSupply_);
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return allowances[owner][spender];
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /// @notice USDT-style transfer: declared WITHOUT a bool return value (returns nothing).
    /// @dev Reverts on insufficient balance/zero recipient but writes ZERO return data on success.
    function transfer(address to, uint256 amount) external {
        require(to != address(0), "Transfer to zero address");
        _transfer(msg.sender, to, amount);
    }

    /// @notice USDT-style transferFrom: declared WITHOUT a bool return value (returns nothing).
    function transferFrom(address from, address to, uint256 amount) external {
        require(to != address(0), "Transfer to zero address");
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount);
    }

    function mint(address to, uint256 amount) external {
        require(to != address(0), "Mint to zero address");
        totalSupply += amount;
        unchecked {
            balances[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balances[from] >= amount, "Transfer amount exceeds balance");
        unchecked {
            balances[from] -= amount;
            balances[to] += amount;
        }
        emit Transfer(from, to, amount);
    }

    function _spendAllowance(address owner, address spender, uint256 amount) internal {
        uint256 currentAllowance = allowances[owner][spender];
        if (currentAllowance != type(uint256).max) {
            require(currentAllowance >= amount, "Insufficient allowance");
            unchecked {
                allowances[owner][spender] = currentAllowance - amount;
            }
        }
    }
}
