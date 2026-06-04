// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.10;

/// @title MockReentrantToken - ERC20 that re-enters a target view on every transfer
/// @notice Standard (bool-returning) ERC20 used to prove the read-only reentrancy guard on the
/// @notice fee-aware views: when armed, each transfer/transferFrom STATICCALLs a target function
/// @notice while the swap's nonReentrant lock is held. If that call reverts with ContractLocked(),
/// @notice the `sawContractLocked` flag is set — proving SecurityLib.checkNotLocked fired mid-swap.
/// @dev The guarded view reverts ContractLocked BEFORE any arg validation, so the armed calldata
/// @dev does not need valid path/amounts; it only matters that the call is made while locked.
contract MockReentrantToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) private balances;
    mapping(address => mapping(address => uint256)) private allowances;

    address public armedTarget;
    bytes public armedCalldata;
    bool public sawContractLocked;

    /// @notice Same signature => same 4-byte selector as SecurityLib.ContractLocked()
    error ContractLocked();

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint256 initialSupply_) {
        name = name_;
        symbol = symbol_;
        totalSupply = initialSupply_;
        balances[msg.sender] = initialSupply_;
        emit Transfer(address(0), msg.sender, initialSupply_);
    }

    /// @notice Arm the reentrancy hook: every subsequent transfer staticcalls target.callData.
    function arm(address target, bytes calldata callData) external {
        armedTarget = target;
        armedCalldata = callData;
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

    function transfer(address to, uint256 amount) external returns (bool) {
        _maybeReenter();
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _maybeReenter();
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount);
        return true;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        unchecked { balances[to] += amount; }
        emit Transfer(address(0), to, amount);
    }

    /// @dev Read-only re-entrancy: STATICCALL the armed view. A revert whose selector matches
    /// @dev ContractLocked() records that the guard fired. STATICCALL keeps this side-effect-free
    /// @dev for the calling swap (the view is read-only), so the swap itself proceeds normally.
    function _maybeReenter() internal {
        address target = armedTarget;
        if (target == address(0)) return;
        (bool ok, bytes memory ret) = target.staticcall(armedCalldata);
        if (!ok && ret.length >= 4 && bytes4(ret) == ContractLocked.selector) {
            sawContractLocked = true;
        }
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "Transfer to zero address");
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
            unchecked { allowances[owner][spender] = currentAllowance - amount; }
        }
    }
}
