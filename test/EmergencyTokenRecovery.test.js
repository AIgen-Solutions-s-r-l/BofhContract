const { expect } = require('chai');
const { ethers } = require('hardhat');

describe('Emergency Token Recovery', function () {
  let bofhContract;
  let mockToken;
  let anotherToken;
  let baseToken;
  let mockFactory;
  let owner;
  let recipient;
  let nonOwner;

  beforeEach(async function () {
    [owner, recipient, nonOwner] = await ethers.getSigners();

    // Deploy mock tokens
    const MockToken = await ethers.getContractFactory('MockToken');

    baseToken = await MockToken.deploy(
      'Wrapped BNB',
      'WBNB',
      ethers.parseEther('1000000')
    );
    await baseToken.waitForDeployment();

    mockToken = await MockToken.deploy(
      'Test Token',
      'TEST',
      ethers.parseEther('1000000')
    );
    await mockToken.waitForDeployment();

    anotherToken = await MockToken.deploy(
      'Another Token',
      'ANOTHER',
      ethers.parseEther('1000000')
    );
    await anotherToken.waitForDeployment();

    // Deploy mock factory
    const MockFactory = await ethers.getContractFactory('MockFactory');
    mockFactory = await MockFactory.deploy();
    await mockFactory.waitForDeployment();

    // Deploy BofhContractV2
    const BofhContractV2 = await ethers.getContractFactory('BofhContractV2');
    bofhContract = await BofhContractV2.deploy(
      await baseToken.getAddress(),
      await mockFactory.getAddress()
    );
    await bofhContract.waitForDeployment();
  });

  describe('Emergency Token Recovery Function', function () {
    it('should successfully recover tokens when contract is paused and caller is owner', async function () {
      const contractAddress = await bofhContract.getAddress();
      const recipientAddress = recipient.address;
      const tokenAddress = await mockToken.getAddress();
      const recoveryAmount = ethers.parseEther('100');

      // Transfer tokens to contract (simulate stuck tokens)
      await mockToken.transfer(contractAddress, recoveryAmount);

      // Verify contract received tokens
      expect(await mockToken.balanceOf(contractAddress)).to.equal(
        recoveryAmount
      );

      // Pause the contract
      await bofhContract.emergencyPause();
      expect(await bofhContract.isPaused()).to.be.true;

      // Get recipient balance before recovery
      const recipientBalanceBefore = await mockToken.balanceOf(
        recipientAddress
      );

      // Recover tokens
      await expect(
        bofhContract.emergencyTokenRecovery(
          tokenAddress,
          recipientAddress,
          recoveryAmount
        )
      )
        .to.emit(bofhContract, 'EmergencyTokenRecovery')
        .withArgs(tokenAddress, recipientAddress, recoveryAmount, owner.address);

      // Verify tokens were transferred to recipient
      expect(await mockToken.balanceOf(recipientAddress)).to.equal(
        recipientBalanceBefore + recoveryAmount
      );

      // Verify contract balance is zero
      expect(await mockToken.balanceOf(contractAddress)).to.equal(0);
    });

    it('should revert when contract is not paused', async function () {
      const contractAddress = await bofhContract.getAddress();
      const tokenAddress = await mockToken.getAddress();
      const recoveryAmount = ethers.parseEther('100');

      // Transfer tokens to contract
      await mockToken.transfer(contractAddress, recoveryAmount);

      // Try to recover without pausing (should fail)
      await expect(
        bofhContract.emergencyTokenRecovery(
          tokenAddress,
          recipient.address,
          recoveryAmount
        )
      ).to.be.revertedWith('BofhContractBase: Contract is not paused');
    });

    it('should revert when caller is not owner', async function () {
      const contractAddress = await bofhContract.getAddress();
      const tokenAddress = await mockToken.getAddress();
      const recoveryAmount = ethers.parseEther('100');

      // Transfer tokens to contract
      await mockToken.transfer(contractAddress, recoveryAmount);

      // Pause the contract
      await bofhContract.emergencyPause();

      // Try to recover as non-owner (should fail)
      await expect(
        bofhContract
          .connect(nonOwner)
          .emergencyTokenRecovery(
            tokenAddress,
            recipient.address,
            recoveryAmount
          )
      ).to.be.revertedWithCustomError(bofhContract, 'Unauthorized');
    });

    it('should revert when token address is zero', async function () {
      const recoveryAmount = ethers.parseEther('100');

      // Pause the contract
      await bofhContract.emergencyPause();

      // Try to recover with zero address (should fail)
      await expect(
        bofhContract.emergencyTokenRecovery(
          ethers.ZeroAddress,
          recipient.address,
          recoveryAmount
        )
      ).to.be.revertedWith('BofhContractBase: Invalid token address');
    });

    it('should revert when recipient address is zero', async function () {
      const tokenAddress = await mockToken.getAddress();
      const recoveryAmount = ethers.parseEther('100');

      // Pause the contract
      await bofhContract.emergencyPause();

      // Try to recover to zero address (should fail)
      await expect(
        bofhContract.emergencyTokenRecovery(
          tokenAddress,
          ethers.ZeroAddress,
          recoveryAmount
        )
      ).to.be.revertedWith('BofhContractBase: Invalid recipient address');
    });

    it('should revert when amount is zero', async function () {
      const tokenAddress = await mockToken.getAddress();

      // Pause the contract
      await bofhContract.emergencyPause();

      // Try to recover zero amount (should fail)
      await expect(
        bofhContract.emergencyTokenRecovery(tokenAddress, recipient.address, 0)
      ).to.be.revertedWith('BofhContractBase: Amount must be greater than zero');
    });

    it('should revert when contract has insufficient balance', async function () {
      const tokenAddress = await mockToken.getAddress();
      const recoveryAmount = ethers.parseEther('100');

      // Pause the contract
      await bofhContract.emergencyPause();

      // Try to recover more tokens than available (should fail)
      await expect(
        bofhContract.emergencyTokenRecovery(
          tokenAddress,
          recipient.address,
          recoveryAmount
        )
      ).to.be.revertedWith('BofhContractBase: Insufficient token balance');
    });

    it('should recover partial amount when less than total balance', async function () {
      const contractAddress = await bofhContract.getAddress();
      const tokenAddress = await mockToken.getAddress();
      const totalAmount = ethers.parseEther('1000');
      const recoveryAmount = ethers.parseEther('300');

      // Transfer tokens to contract
      await mockToken.transfer(contractAddress, totalAmount);

      // Pause the contract
      await bofhContract.emergencyPause();

      // Recover partial amount
      await bofhContract.emergencyTokenRecovery(
        tokenAddress,
        recipient.address,
        recoveryAmount
      );

      // Verify partial recovery
      expect(await mockToken.balanceOf(recipient.address)).to.equal(
        recoveryAmount
      );
      expect(await mockToken.balanceOf(contractAddress)).to.equal(
        totalAmount - recoveryAmount
      );
    });

    it('should recover multiple different tokens in sequence', async function () {
      const contractAddress = await bofhContract.getAddress();
      const token1Address = await mockToken.getAddress();
      const token2Address = await anotherToken.getAddress();
      const amount1 = ethers.parseEther('100');
      const amount2 = ethers.parseEther('200');

      // Transfer different tokens to contract
      await mockToken.transfer(contractAddress, amount1);
      await anotherToken.transfer(contractAddress, amount2);

      // Pause the contract
      await bofhContract.emergencyPause();

      // Recover first token
      await bofhContract.emergencyTokenRecovery(
        token1Address,
        recipient.address,
        amount1
      );

      // Recover second token
      await bofhContract.emergencyTokenRecovery(
        token2Address,
        recipient.address,
        amount2
      );

      // Verify both tokens were recovered
      expect(await mockToken.balanceOf(recipient.address)).to.equal(amount1);
      expect(await anotherToken.balanceOf(recipient.address)).to.equal(amount2);
    });

    it('should emit event with correct parameters', async function () {
      const contractAddress = await bofhContract.getAddress();
      const tokenAddress = await mockToken.getAddress();
      const recipientAddress = recipient.address;
      const recoveryAmount = ethers.parseEther('50');

      // Transfer tokens to contract
      await mockToken.transfer(contractAddress, recoveryAmount);

      // Pause the contract
      await bofhContract.emergencyPause();

      // Verify event emission with all parameters
      await expect(
        bofhContract.emergencyTokenRecovery(
          tokenAddress,
          recipientAddress,
          recoveryAmount
        )
      )
        .to.emit(bofhContract, 'EmergencyTokenRecovery')
        .withArgs(
          tokenAddress,
          recipientAddress,
          recoveryAmount,
          owner.address // recoveredBy
        );
    });

    it('should recover a non-standard token whose transfer() returns NO data (USDT/BSC-USD style)', async function () {
      // Regression (FIX A): require(IBEP20(token).transfer(...)) reverts for zero-returndata
      // tokens, permanently locking exactly the token class the swap path handles tolerantly.
      // SwapMathLib.safeTransfer must succeed here.
      const contractAddress = await bofhContract.getAddress();
      const recipientAddress = recipient.address;
      const recoveryAmount = ethers.parseEther('100');

      const MockNoReturnToken = await ethers.getContractFactory('MockNoReturnToken');
      const noReturnToken = await MockNoReturnToken.deploy(
        'No Return USDT',
        'USDT',
        ethers.parseEther('1000000')
      );
      await noReturnToken.waitForDeployment();
      const tokenAddress = await noReturnToken.getAddress();

      // Transfer no-return tokens into the contract (simulate stuck tokens).
      await noReturnToken.transfer(contractAddress, recoveryAmount);
      expect(await noReturnToken.balanceOf(contractAddress)).to.equal(recoveryAmount);

      // Pause for emergency recovery.
      await bofhContract.emergencyPause();

      const recipientBalanceBefore = await noReturnToken.balanceOf(recipientAddress);

      // Recovery must SUCCEED (not revert) and emit the event for the non-standard token.
      await expect(
        bofhContract.emergencyTokenRecovery(
          tokenAddress,
          recipientAddress,
          recoveryAmount
        )
      )
        .to.emit(bofhContract, 'EmergencyTokenRecovery')
        .withArgs(tokenAddress, recipientAddress, recoveryAmount, owner.address);

      // Tokens actually moved to the recipient and the contract was drained.
      expect(await noReturnToken.balanceOf(recipientAddress)).to.equal(
        recipientBalanceBefore + recoveryAmount
      );
      expect(await noReturnToken.balanceOf(contractAddress)).to.equal(0);
    });

    it('should not allow recovery after unpausing the contract', async function () {
      const contractAddress = await bofhContract.getAddress();
      const tokenAddress = await mockToken.getAddress();
      const recoveryAmount = ethers.parseEther('100');

      // Transfer tokens to contract
      await mockToken.transfer(contractAddress, recoveryAmount);

      // Pause the contract
      await bofhContract.emergencyPause();

      // Unpause the contract
      await bofhContract.emergencyUnpause();

      // Try to recover after unpausing (should fail)
      await expect(
        bofhContract.emergencyTokenRecovery(
          tokenAddress,
          recipient.address,
          recoveryAmount
        )
      ).to.be.revertedWith('BofhContractBase: Contract is not paused');
    });
  });
});
