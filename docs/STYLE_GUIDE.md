# BofhContract Code Style Guide

Comprehensive style guide for Solidity, JavaScript, and Python code in the BofhContract project.

## Table of Contents

- [General Principles](#general-principles)
- [Solidity Style](#solidity-style)
- [JavaScript Style](#javascript-style)
- [Python Style](#python-style)
- [Documentation](#documentation)
- [Git Commit Messages](#git-commit-messages)

---

## General Principles

### Code Quality
- **Readability over cleverness** - Code is read more than written
- **Consistency** - Follow established patterns in the codebase
- **Simplicity** - Prefer simple solutions over complex ones
- **Documentation** - Document why, not what
- **Testing** - All code must have tests

### File Organization
- One contract per file (Solidity)
- Related functionality grouped together
- Clear file naming (PascalCase for contracts, kebab-case for scripts)

---

## Solidity Style

Based on the [Official Solidity Style Guide](https://docs.soliditylang.org/en/latest/style-guide.html) with project-specific adaptations.

### Naming Conventions

#### Contracts
```solidity
// PascalCase
contract BofhContractV2 { }
contract MockToken { }
```

#### Functions
```solidity
// camelCase for external/public functions
function executeSwap() external { }
function getBaseToken() public view returns (address) { }

// Leading underscore for internal/private functions
function _executeSwap() internal { }
function _validateInputs() private view { }
```

#### Variables
```solidity
// camelCase for state variables
address public baseToken;
uint256 public maxPriceImpact;

// Leading underscore for private state variables
uint256 private _nonce;
mapping(address => bool) private _blacklisted;

// camelCase for local variables
uint256 expectedOutput;
address pairAddress;

// camelCase for function parameters
function swap(address tokenIn, uint256 amountIn) { }
```

#### Constants
```solidity
// UPPER_SNAKE_CASE
uint256 private constant MAX_FEE_BPS = 1000;
uint256 public constant MAX_PATH_LENGTH = 6;
uint256 internal constant PRECISION = 1e6;
```

#### Events
```solidity
// PascalCase with descriptive names
event SwapExecuted(address indexed initiator, uint256 amount);
event RiskParamsUpdated(uint256 maxVolume, uint256 minLiquidity);
```

#### Modifiers
```solidity
// camelCase
modifier onlyOwner() { }
modifier whenNotPaused() { }
modifier nonReentrant() { }
```

#### Enums
```solidity
// PascalCase for enum name, UPPER_SNAKE_CASE for values
enum Status {
    PENDING,
    ACTIVE,
    COMPLETED
}
```

### Code Organization

#### File Structure
```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.10;

// 1. Imports (grouped by source)
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./BofhContractBase.sol";

// 2. Contract declaration with NatSpec
/// @title BofhContractV2
/// @notice Brief description
/// @dev Implementation details
contract BofhContractV2 is BofhContractBase {
    // 3. Type declarations (structs, enums)
    struct SwapState { }

    // 4. State variables
    //    - public
    //    - internal
    //    - private

    // 5. Events
    event SwapExecuted();

    // 6. Errors
    error InvalidPath();

    // 7. Modifiers
    modifier validPath() { }

    // 8. Constructor
    constructor() { }

    // 9. External functions
    function executeSwap() external { }

    // 10. Public functions
    function getBaseToken() public view returns (address) { }

    // 11. Internal functions
    function _executeSwap() internal { }

    // 12. Private functions
    function _validatePath() private view { }
}
```

### Formatting Rules

#### Line Length
```solidity
// Maximum 120 characters
// Break long lines at logical points

// Good
function executeMultiSwap(
    address[][] calldata paths,
    uint256[][] calldata fees,
    uint256[] calldata amounts
) external returns (uint256[] memory) { }

// Bad
function executeMultiSwap(address[][] calldata paths, uint256[][] calldata fees, uint256[] calldata amounts) external returns (uint256[] memory) { }
```

#### Indentation
```solidity
// 4 spaces (no tabs)
contract Example {
    function foo() public {
        if (condition) {
            doSomething();
        }
    }
}
```

#### Spacing
```solidity
// Spaces around operators
uint256 result = a + b;
bool isValid = x > 0 && y < 100;

// No spaces inside brackets/braces for Solidity
if (condition) {
    doSomething();
}

// Space after comma
function foo(uint256 a, uint256 b) { }
```

#### Braces
```solidity
// Opening brace on same line
function foo() public {
    // ...
}

// Closing brace on new line
if (condition) {
    doSomething();
} else {
    doSomethingElse();
}
```

### Documentation

#### NatSpec Comments
```solidity
/// @title Brief contract title
/// @notice User-facing description
/// @dev Developer notes and implementation details
contract Example {
    /// @notice Transfer tokens to recipient
    /// @dev Validates recipient address and amount
    /// @param to Recipient address
    /// @param amount Token amount to transfer
    /// @return success True if transfer succeeded
    /// @custom:security Uses SafeTransfer pattern
    function transfer(address to, uint256 amount)
        external
        returns (bool success)
    {
        // Implementation
    }
}
```

#### Inline Comments
```solidity
// Use // for single-line comments
// Explain WHY, not WHAT

// Good: Explains reasoning
// Skip volatility calculation for same-block swaps (gas optimization)
if (lastTimestamp >= timestamp) {
    return PRECISION / 100;
}

// Bad: States the obvious
// Check if lastTimestamp is greater than or equal to timestamp
if (lastTimestamp >= timestamp) {
    return PRECISION / 100;
}
```

### Error Handling

#### Custom Errors
```solidity
// Prefer custom errors over require strings (gas efficient)

// Good
error InvalidAmount();
error InsufficientBalance(uint256 requested, uint256 available);

if (amount == 0) revert InvalidAmount();
if (balance < amount) revert InsufficientBalance(amount, balance);

// Avoid (except for backward compatibility)
require(amount > 0, "Invalid amount");
```

### Security Patterns

#### Checks-Effects-Interactions
```solidity
function withdraw(uint256 amount) external {
    // 1. Checks
    require(balances[msg.sender] >= amount, "Insufficient balance");

    // 2. Effects
    balances[msg.sender] -= amount;

    // 3. Interactions
    (bool success, ) = msg.sender.call{value: amount}("");
    require(success, "Transfer failed");
}
```

#### Reentrancy Guards
```solidity
// Always use nonReentrant for state-changing external functions
function executeSwap() external nonReentrant whenNotPaused {
    // ...
}
```

---

## JavaScript Style

Based on [Airbnb JavaScript Style Guide](https://github.com/airbnb/javascript) with project-specific adaptations.

### Naming Conventions

#### Variables and Functions
```javascript
// camelCase
const baseToken = '0x...';
let swapAmount = 100;

function executeSwap() { }
async function getSwapMetrics() { }
```

#### Constants
```javascript
// UPPER_SNAKE_CASE for true constants
const MAX_GAS_LIMIT = 300000;
const DEFAULT_SLIPPAGE = 0.01;

// camelCase for configuration objects
const config = {
    networkId: 97,
    rpcUrl: 'https://...'
};
```

#### Classes
```javascript
// PascalCase
class MetricsTracker { }
class ContractMonitor { }
```

### Code Style

#### Semicolons
```javascript
// Always use semicolons
const foo = 'bar';
doSomething();
```

#### Quotes
```javascript
// Single quotes for strings
const name = 'BofhContract';
const message = 'Swap executed';

// Template literals for interpolation
const output = `Swap ${id} completed`;
```

#### Arrow Functions
```javascript
// Prefer arrow functions for callbacks
array.map((item) => item.value);
array.filter((item) => item.active);

// Use async/await over promises
async function fetchData() {
    const result = await api.call();
    return result;
}
```

#### Object/Array Destructuring
```javascript
// Use destructuring
const { baseToken, factory } = config;
const [first, second] = array;

// Object shorthand
const name = 'test';
const obj = { name, value: 100 };
```

#### Spacing
```javascript
// Spaces inside braces for objects
const obj = { a: 1, b: 2 };

// Space after keywords
if (condition) { }
for (let i = 0; i < 10; i++) { }

// Space around operators
const sum = a + b;
const isValid = x === y;
```

### Hardhat Scripts

```javascript
const { ethers } = require('hardhat');

async function main() {
    // Get signers
    const [deployer] = await ethers.getSigners();

    console.log('Deploying with account:', deployer.address);

    // Deploy contract
    const Contract = await ethers.getContractFactory('BofhContractV2');
    const contract = await Contract.deploy(baseToken, factory);

    await contract.deployed();

    console.log('Contract deployed to:', contract.address);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
```

---

## Python Style

Based on [PEP 8](https://peps.python.org/pep-0008/) with project-specific adaptations.

### Naming Conventions

#### Variables and Functions
```python
# snake_case
base_token = "0x..."
swap_amount = 100

def execute_swap():
    pass

async def get_swap_metrics():
    pass
```

#### Constants
```python
# UPPER_SNAKE_CASE
MAX_GAS_LIMIT = 300000
DEFAULT_SLIPPAGE = 0.01
```

#### Classes
```python
# PascalCase
class MetricsTracker:
    pass

class ContractMonitor:
    pass
```

#### Private Members
```python
# Leading underscore for private
class Example:
    def __init__(self):
        self._private_var = 10

    def _private_method(self):
        pass
```

### Code Style

#### Indentation
```python
# 4 spaces
def function():
    if condition:
        do_something()
```

#### Line Length
```python
# Maximum 100 characters (not 80)
# Break long lines logically

# Good
result = some_function(
    first_parameter,
    second_parameter,
    third_parameter
)

# Use backslash for long strings
message = "This is a very long string that " \
          "spans multiple lines"
```

#### Imports
```python
# Standard library
import os
import sys

# Third-party
from web3 import Web3
import click

# Local
from bofh.utils.solidity import get_abi
from bofh.utils.web3 import get_contract
```

#### Docstrings
```python
def execute_swap(path, amount):
    """
    Execute a token swap along the specified path.

    Args:
        path (list): List of token addresses
        amount (int): Amount to swap in wei

    Returns:
        int: Output amount in wei

    Raises:
        ValueError: If path is invalid
        InsufficientBalance: If balance too low
    """
    pass
```

---

## Documentation

### README Files
- Every major directory should have a README.md
- Explain purpose, usage, and examples
- Keep updated with code changes

### Code Comments
- Use comments to explain **why**, not **what**
- Document non-obvious decisions
- Include references to issues/PRs for complex changes

### NatSpec (Solidity)
- All public/external functions must have NatSpec
- Include @param and @return for all parameters
- Use @custom tags for additional context

---

## Git Commit Messages

### Format
```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `style`: Code style (formatting, missing semicolons)
- `refactor`: Code change that neither fixes bug nor adds feature
- `perf`: Performance improvement
- `test`: Adding missing tests
- `chore`: Changes to build process or tools

### Examples
```
feat(swap): add multi-DEX routing via per-hop dexId registry

Resolve each hop's factory + fee from an owner-managed registry so one
deployment can route a path across multiple V2 forks.

Closes #NN
```

```
fix(validation): correct path length validation

Path length check was off by one, allowing paths longer than
MAX_PATH_LENGTH. Fixed to properly enforce the limit.

Fixes #108
```

---

## Linting Commands

### Solidity
```bash
# Lint all Solidity files
npm run lint:sol

# Auto-fix Solidity issues
npm run lint:sol:fix
```

### JavaScript
```bash
# Lint all JavaScript files
npm run lint:js

# Auto-fix JavaScript issues
npm run lint:js:fix
```

### Format All
```bash
# Format all files with Prettier
npm run format

# Check formatting without changes
npm run format:check
```

### Pre-commit
```bash
# Install pre-commit hooks
npm run prepare

# Manually run pre-commit checks
npx lint-staged
```

---

## Editor Setup

### VSCode

**.vscode/settings.json**:
```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  },
  "[solidity]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode",
    "editor.tabSize": 4
  },
  "[javascript]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode",
    "editor.tabSize": 2
  },
  "[python]": {
    "editor.tabSize": 4
  }
}
```

**Required Extensions**:
- Prettier - Code formatter
- ESLint
- Solidity (Juan Blanco)

### Sublime Text
- Install Package Control
- Install Prettier plugin
- Install ESLint plugin
- Install SublimeLinter-contrib-solhint

---

## Enforcement

### Pre-commit Hooks
- Automatically format code before commit
- Run linters on staged files
- Prevent commits with linting errors

### CI/CD
- GitHub Actions runs linting on all PRs
- PRs must pass linting checks to merge
- Automated formatting checks

---

**Last Updated:** 2025-11-07
**Version:** 1.0
**Maintainer:** BofhContract Team
