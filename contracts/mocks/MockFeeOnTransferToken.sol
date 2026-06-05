// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.10;

/// @title MockFeeOnTransferToken - ERC20 that skims a fee on every transfer
/// @notice Delivers (amount - transferFeeBps) to the recipient and burns the skimmed fee.
/// @dev Needed because MockToken delivers the full amount. Used only by the FoT tests to prove
/// @dev the router's entry sizing (realized balanceOf delta) handles fee-on-transfer tokens.
contract MockFeeOnTransferToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    /// @notice Transfer fee in basis points out of 10000 (e.g. 100 = 1%). Settable for tests.
    uint256 public transferFeeBps;

    mapping(address => uint256) private balances;
    mapping(address => mapping(address => uint256)) private allowances;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 initialSupply_,
        uint256 transferFeeBps_
    ) {
        name = name_;
        symbol = symbol_;
        totalSupply = initialSupply_;
        transferFeeBps = transferFeeBps_;
        balances[msg.sender] = initialSupply_;
        emit Transfer(address(0), msg.sender, initialSupply_);
    }

    /// @notice Set the transfer fee in basis points out of 10000
    function setTransferFeeBps(uint256 feeBps) external {
        transferFeeBps = feeBps;
    }

    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return allowances[owner][spender];
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        require(spender != address(0), "Approve to zero address");
        allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 currentAllowance = allowances[from][msg.sender];
        if (currentAllowance != type(uint256).max) {
            require(currentAllowance >= amount, "Insufficient allowance");
            unchecked {
                allowances[from][msg.sender] = currentAllowance - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    function mint(address to, uint256 amount) external {
        require(to != address(0), "Mint to zero address");
        totalSupply += amount;
        unchecked {
            balances[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    /// @dev Deducts `amount` from sender; delivers amount minus the fee to `to`; burns the fee.
    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "Transfer to zero address");
        require(balances[from] >= amount, "Transfer amount exceeds balance");

        uint256 fee = (amount * transferFeeBps) / 10000;
        uint256 net = amount - fee;

        unchecked {
            balances[from] -= amount;
            balances[to] += net;
        }
        if (fee > 0) {
            // Burn the skimmed fee (reduces total supply) so x*y=k math reflects the net delivered.
            unchecked {
                totalSupply -= fee;
            }
            emit Transfer(from, address(0), fee);
        }
        emit Transfer(from, to, net);
    }
}
