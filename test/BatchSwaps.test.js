const { expect } = require('chai');
const { ethers } = require('hardhat');

describe('Batch Swap Execution Tests', function () {
  let bofhContract;
  let baseToken;
  let tokenA, tokenB, tokenC;
  let mockFactory;
  let owner, user1, user2, user3;

  beforeEach(async function () {
    [owner, user1, user2, user3] = await ethers.getSigners();

    // Deploy mock tokens
    const MockToken = await ethers.getContractFactory('MockToken');

    baseToken = await MockToken.deploy(
      'Wrapped BNB',
      'WBNB',
      ethers.parseEther('10000000')
    );
    await baseToken.waitForDeployment();

    tokenA = await MockToken.deploy(
      'Test Token A',
      'TKNA',
      ethers.parseEther('10000000')
    );
    await tokenA.waitForDeployment();

    tokenB = await MockToken.deploy(
      'Test Token B',
      'TKNB',
      ethers.parseEther('10000000')
    );
    await tokenB.waitForDeployment();

    tokenC = await MockToken.deploy(
      'Test Token C',
      'TKNC',
      ethers.parseEther('10000000')
    );
    await tokenC.waitForDeployment();

    // Deploy mock factory
    const MockFactory = await ethers.getContractFactory('MockFactory');
    mockFactory = await MockFactory.deploy();
    await mockFactory.waitForDeployment();

    const baseAddr = await baseToken.getAddress();
    const tokenAAddr = await tokenA.getAddress();
    const tokenBAddr = await tokenB.getAddress();
    const tokenCAddr = await tokenC.getAddress();

    // Create pairs
    await mockFactory.createPair(baseAddr, tokenAAddr);
    await mockFactory.createPair(baseAddr, tokenBAddr);
    await mockFactory.createPair(baseAddr, tokenCAddr);
    await mockFactory.createPair(tokenAAddr, tokenBAddr); // For multi-hop swaps

    // Deploy BofhContractV2
    const BofhContractV2 = await ethers.getContractFactory('BofhContractV2');
    bofhContract = await BofhContractV2.deploy(
      baseAddr,
      await mockFactory.getAddress()
    );
    await bofhContract.waitForDeployment();

    // Add liquidity to pairs
    const contractAddress = await bofhContract.getAddress();
    const pairAAddr = await mockFactory.getPair(baseAddr, tokenAAddr);
    const pairBAddr = await mockFactory.getPair(baseAddr, tokenBAddr);
    const pairCAddr = await mockFactory.getPair(baseAddr, tokenCAddr);
    const pairABAddr = await mockFactory.getPair(tokenAAddr, tokenBAddr);

    // Transfer tokens to pairs for liquidity
    await baseToken.transfer(pairAAddr, ethers.parseEther('100000'));
    await tokenA.transfer(pairAAddr, ethers.parseEther('100000'));

    await baseToken.transfer(pairBAddr, ethers.parseEther('100000'));
    await tokenB.transfer(pairBAddr, ethers.parseEther('100000'));

    await baseToken.transfer(pairCAddr, ethers.parseEther('100000'));
    await tokenC.transfer(pairCAddr, ethers.parseEther('100000'));

    await tokenA.transfer(pairABAddr, ethers.parseEther('100000'));
    await tokenB.transfer(pairABAddr, ethers.parseEther('100000'));

    // Sync pairs to update reserves after liquidity transfer
    const MockPair = await ethers.getContractFactory('MockPair');
    const pairA = MockPair.attach(pairAAddr);
    const pairB = MockPair.attach(pairBAddr);
    const pairC = MockPair.attach(pairCAddr);
    const pairAB = MockPair.attach(pairABAddr);

    await pairA.sync();
    await pairB.sync();
    await pairC.sync();
    await pairAB.sync();

    // Approve contract to spend tokens
    await baseToken.approve(contractAddress, ethers.parseEther('1000000'));
    await baseToken
      .connect(user1)
      .approve(contractAddress, ethers.parseEther('1000000'));
    await baseToken
      .connect(user2)
      .approve(contractAddress, ethers.parseEther('1000000'));

    // Fund users with base tokens
    await baseToken.transfer(user1.address, ethers.parseEther('10000'));
    await baseToken.transfer(user2.address, ethers.parseEther('10000'));
  });

  describe('Batch Swap Validation', function () {
    it('should reject empty batch', async function () {
      await expect(bofhContract.executeBatchSwaps([])).to.be.revertedWithCustomError(
        bofhContract,
        'InvalidArrayLength'
      );
    });

    it('should reject batch size exceeding 10 swaps', async function () {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const baseAddr = await baseToken.getAddress();
      const tokenAAddr = await tokenA.getAddress();

      // Create 11 swap params (exceeds limit of 10)
      const swaps = Array(11)
        .fill(null)
        .map(() => ({
          path: [baseAddr, tokenAAddr, baseAddr],
          fees: [30, 30],
          amountIn: ethers.parseEther('10'),
          minAmountOut: ethers.parseEther('9'),
          deadline: deadline,
          recipient: owner.address
        }));

      await expect(
        bofhContract.executeBatchSwaps(swaps)
      ).to.be.revertedWithCustomError(bofhContract, 'BatchSizeExceeded');
    });

    it('should reject swap with zero recipient address', async function () {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const baseAddr = await baseToken.getAddress();
      const tokenAAddr = await tokenA.getAddress();

      const swaps = [
        {
          path: [baseAddr, tokenAAddr, baseAddr],
          fees: [30, 30],
          amountIn: ethers.parseEther('10'),
          minAmountOut: ethers.parseEther('9'),
          deadline: deadline,
          recipient: ethers.ZeroAddress // Invalid recipient
        }
      ];

      await expect(
        bofhContract.executeBatchSwaps(swaps)
      ).to.be.revertedWithCustomError(bofhContract, 'InvalidAddress');
    });

    it('should reject swap with expired deadline', async function () {
      const expiredDeadline = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      const baseAddr = await baseToken.getAddress();
      const tokenAAddr = await tokenA.getAddress();

      const swaps = [
        {
          path: [baseAddr, tokenAAddr, baseAddr],
          fees: [30, 30],
          amountIn: ethers.parseEther('10'),
          minAmountOut: ethers.parseEther('9'),
          deadline: expiredDeadline,
          recipient: owner.address
        }
      ];

      await expect(
        bofhContract.executeBatchSwaps(swaps)
      ).to.be.revertedWithCustomError(bofhContract, 'DeadlineExpired');
    });

    it('should reject swap with invalid path (not starting with base token)', async function () {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const baseAddr = await baseToken.getAddress();
      const tokenAAddr = await tokenA.getAddress();

      const swaps = [
        {
          path: [tokenAAddr, baseAddr], // Invalid: doesn't start with base
          fees: [30],
          amountIn: ethers.parseEther('10'),
          minAmountOut: ethers.parseEther('9'),
          deadline: deadline,
          recipient: owner.address
        }
      ];

      await expect(
        bofhContract.executeBatchSwaps(swaps)
      ).to.be.revertedWithCustomError(bofhContract, 'InvalidPath');
    });

    it('should reject swap with invalid path (not ending with base token)', async function () {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const baseAddr = await baseToken.getAddress();
      const tokenAAddr = await tokenA.getAddress();

      const swaps = [
        {
          path: [baseAddr, tokenAAddr], // Invalid: doesn't end with base
          fees: [30],
          amountIn: ethers.parseEther('10'),
          minAmountOut: ethers.parseEther('9'),
          deadline: deadline,
          recipient: owner.address
        }
      ];

      await expect(
        bofhContract.executeBatchSwaps(swaps)
      ).to.be.revertedWithCustomError(bofhContract, 'InvalidPath');
    });
  });

  describe('Single Batch Execution', function () {
    it('should execute single swap in batch successfully', async function () {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const baseAddr = await baseToken.getAddress();
      const tokenAAddr = await tokenA.getAddress();

      const swaps = [
        {
          path: [baseAddr, tokenAAddr, baseAddr],
          fees: [30, 30],
          amountIn: ethers.parseEther('100'),
          minAmountOut: ethers.parseEther('95'),
          deadline: deadline,
          recipient: owner.address
        }
      ];

      const balanceBefore = await baseToken.balanceOf(owner.address);

      const tx = await bofhContract.executeBatchSwaps(swaps);
      const receipt = await tx.wait();

      const balanceAfter = await baseToken.balanceOf(owner.address);

      // Should have less base tokens (input) but more than before (output)
      expect(balanceAfter).to.be.lessThan(balanceBefore);
    });

    it('should emit BatchSwapExecuted event', async function () {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const baseAddr = await baseToken.getAddress();
      const tokenAAddr = await tokenA.getAddress();
      const amountIn = ethers.parseEther('100');

      const swaps = [
        {
          path: [baseAddr, tokenAAddr, baseAddr],
          fees: [30, 30],
          amountIn: amountIn,
          minAmountOut: ethers.parseEther('95'),
          deadline: deadline,
          recipient: owner.address
        }
      ];

      await expect(bofhContract.executeBatchSwaps(swaps))
        .to.emit(bofhContract, 'BatchSwapExecuted')
        .withArgs(owner.address, 1, amountIn, (output) => output > 0n);
    });
  });

  describe('Multiple Swaps in Batch', function () {
    it('should execute 2 swaps to same recipient', async function () {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const baseAddr = await baseToken.getAddress();
      const tokenAAddr = await tokenA.getAddress();
      const tokenBAddr = await tokenB.getAddress();

      const swaps = [
        {
          path: [baseAddr, tokenAAddr, baseAddr],
          fees: [30, 30],
          amountIn: ethers.parseEther('100'),
          minAmountOut: ethers.parseEther('95'),
          deadline: deadline,
          recipient: owner.address
        },
        {
          path: [baseAddr, tokenBAddr, baseAddr],
          fees: [30, 30],
          amountIn: ethers.parseEther('100'),
          minAmountOut: ethers.parseEther('95'),
          deadline: deadline,
          recipient: owner.address
        }
      ];

      const balanceBefore = await baseToken.balanceOf(owner.address);

      const outputs = await bofhContract.executeBatchSwaps.staticCall(swaps);
      await bofhContract.executeBatchSwaps(swaps);

      const balanceAfter = await baseToken.balanceOf(owner.address);

      // Verify 2 outputs
      expect(outputs.length).to.equal(2);
      expect(outputs[0]).to.be.greaterThan(0);
      expect(outputs[1]).to.be.greaterThan(0);

      // Total input: 200, should receive outputs back
      const totalInput = ethers.parseEther('200');
      const totalOutput = outputs[0] + outputs[1];

      expect(balanceAfter).to.equal(balanceBefore - totalInput + totalOutput);
    });

    it('should execute 3 swaps to different recipients', async function () {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const baseAddr = await baseToken.getAddress();
      const tokenAAddr = await tokenA.getAddress();
      const tokenBAddr = await tokenB.getAddress();
      const tokenCAddr = await tokenC.getAddress();

      const swaps = [
        {
          path: [baseAddr, tokenAAddr, baseAddr],
          fees: [30, 30],
          amountIn: ethers.parseEther('100'),
          minAmountOut: ethers.parseEther('95'),
          deadline: deadline,
          recipient: user1.address
        },
        {
          path: [baseAddr, tokenBAddr, baseAddr],
          fees: [30, 30],
          amountIn: ethers.parseEther('100'),
          minAmountOut: ethers.parseEther('95'),
          deadline: deadline,
          recipient: user2.address
        },
        {
          path: [baseAddr, tokenCAddr, baseAddr],
          fees: [30, 30],
          amountIn: ethers.parseEther('100'),
          minAmountOut: ethers.parseEther('95'),
          deadline: deadline,
          recipient: user3.address
        }
      ];

      const user1BalanceBefore = await baseToken.balanceOf(user1.address);
      const user2BalanceBefore = await baseToken.balanceOf(user2.address);
      const user3BalanceBefore = await baseToken.balanceOf(user3.address);

      const outputs = await bofhContract.executeBatchSwaps.staticCall(swaps);
      await bofhContract.executeBatchSwaps(swaps);

      const user1BalanceAfter = await baseToken.balanceOf(user1.address);
      const user2BalanceAfter = await baseToken.balanceOf(user2.address);
      const user3BalanceAfter = await baseToken.balanceOf(user3.address);

      // Each user should receive their respective output
      expect(user1BalanceAfter).to.equal(user1BalanceBefore + outputs[0]);
      expect(user2BalanceAfter).to.equal(user2BalanceBefore + outputs[1]);
      expect(user3BalanceAfter).to.equal(user3BalanceBefore + outputs[2]);
    });

    it('should execute maximum batch size (10 swaps)', async function () {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const baseAddr = await baseToken.getAddress();
      const tokenAAddr = await tokenA.getAddress();

      // Create 10 swaps (maximum allowed)
      const swaps = Array(10)
        .fill(null)
        .map(() => ({
          path: [baseAddr, tokenAAddr, baseAddr],
          fees: [30, 30],
          amountIn: ethers.parseEther('10'),
          minAmountOut: ethers.parseEther('9'),
          deadline: deadline,
          recipient: owner.address
        }));

      const balanceBefore = await baseToken.balanceOf(owner.address);

      const outputs = await bofhContract.executeBatchSwaps.staticCall(swaps);
      await bofhContract.executeBatchSwaps(swaps);

      const balanceAfter = await baseToken.balanceOf(owner.address);

      // Verify 10 outputs
      expect(outputs.length).to.equal(10);

      // All outputs should be positive
      outputs.forEach((output) => {
        expect(output).to.be.greaterThan(0);
      });

      // Total input: 100, should receive outputs back
      const totalInput = ethers.parseEther('100');
      const totalOutput = outputs.reduce((sum, output) => sum + output, 0n);

      expect(balanceAfter).to.equal(balanceBefore - totalInput + totalOutput);
    });
  });

  describe('Atomic Execution', function () {
    it('should revert entire batch if one swap fails (insufficient output)', async function () {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const baseAddr = await baseToken.getAddress();
      const tokenAAddr = await tokenA.getAddress();
      const tokenBAddr = await tokenB.getAddress();

      const swaps = [
        {
          path: [baseAddr, tokenAAddr, baseAddr],
          fees: [30, 30],
          amountIn: ethers.parseEther('100'),
          minAmountOut: ethers.parseEther('95'),
          deadline: deadline,
          recipient: owner.address
        },
        {
          path: [baseAddr, tokenBAddr, baseAddr],
          fees: [30, 30],
          amountIn: ethers.parseEther('100'),
          minAmountOut: ethers.parseEther('999999'), // Impossible to achieve
          deadline: deadline,
          recipient: owner.address
        }
      ];

      const balanceBefore = await baseToken.balanceOf(owner.address);

      // Should revert due to second swap's impossible minAmountOut
      await expect(
        bofhContract.executeBatchSwaps(swaps)
      ).to.be.revertedWithCustomError(bofhContract, 'InsufficientOutput');

      const balanceAfter = await baseToken.balanceOf(owner.address);

      // Balance should be unchanged (atomic revert)
      expect(balanceAfter).to.equal(balanceBefore);
    });

    it('should revert entire batch if one swap has expired deadline', async function () {
      const validDeadline = Math.floor(Date.now() / 1000) + 3600;
      const expiredDeadline = Math.floor(Date.now() / 1000) - 3600;
      const baseAddr = await baseToken.getAddress();
      const tokenAAddr = await tokenA.getAddress();
      const tokenBAddr = await tokenB.getAddress();

      const swaps = [
        {
          path: [baseAddr, tokenAAddr, baseAddr],
          fees: [30, 30],
          amountIn: ethers.parseEther('100'),
          minAmountOut: ethers.parseEther('95'),
          deadline: validDeadline,
          recipient: owner.address
        },
        {
          path: [baseAddr, tokenBAddr, baseAddr],
          fees: [30, 30],
          amountIn: ethers.parseEther('100'),
          minAmountOut: ethers.parseEther('95'),
          deadline: expiredDeadline, // Expired
          recipient: owner.address
        }
      ];

      await expect(
        bofhContract.executeBatchSwaps(swaps)
      ).to.be.revertedWithCustomError(bofhContract, 'DeadlineExpired');
    });
  });

  describe('Gas Consumption', function () {
    it('should measure gas for single swap in batch', async function () {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const baseAddr = await baseToken.getAddress();
      const tokenAAddr = await tokenA.getAddress();

      const swaps = [
        {
          path: [baseAddr, tokenAAddr, baseAddr],
          fees: [30, 30],
          amountIn: ethers.parseEther('100'),
          minAmountOut: ethers.parseEther('95'),
          deadline: deadline,
          recipient: owner.address
        }
      ];

      const tx = await bofhContract.executeBatchSwaps(swaps);
      const receipt = await tx.wait();

      console.log(`      Gas for 1 batch swap: ${receipt.gasUsed.toString()}`);
    });

    it('should measure gas for 2 swaps in batch', async function () {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const baseAddr = await baseToken.getAddress();
      const tokenAAddr = await tokenA.getAddress();
      const tokenBAddr = await tokenB.getAddress();

      const swaps = [
        {
          path: [baseAddr, tokenAAddr, baseAddr],
          fees: [30, 30],
          amountIn: ethers.parseEther('100'),
          minAmountOut: ethers.parseEther('95'),
          deadline: deadline,
          recipient: owner.address
        },
        {
          path: [baseAddr, tokenBAddr, baseAddr],
          fees: [30, 30],
          amountIn: ethers.parseEther('100'),
          minAmountOut: ethers.parseEther('95'),
          deadline: deadline,
          recipient: owner.address
        }
      ];

      const tx = await bofhContract.executeBatchSwaps(swaps);
      const receipt = await tx.wait();

      console.log(`      Gas for 2 batch swaps: ${receipt.gasUsed.toString()}`);
    });

    it('should measure gas for 5 swaps in batch', async function () {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const baseAddr = await baseToken.getAddress();
      const tokenAAddr = await tokenA.getAddress();

      const swaps = Array(5)
        .fill(null)
        .map(() => ({
          path: [baseAddr, tokenAAddr, baseAddr],
          fees: [30, 30],
          amountIn: ethers.parseEther('10'),
          minAmountOut: ethers.parseEther('9'),
          deadline: deadline,
          recipient: owner.address
        }));

      const tx = await bofhContract.executeBatchSwaps(swaps);
      const receipt = await tx.wait();

      console.log(`      Gas for 5 batch swaps: ${receipt.gasUsed.toString()}`);
    });
  });

  describe('MEV Protection', function () {
    it.skip('should apply MEV protection at batch level', async function () {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const baseAddr = await baseToken.getAddress();
      const tokenAAddr = await tokenA.getAddress();

      // Configure MEV protection
      await bofhContract.configureMEVProtection(true, 3, 10); // Max 3 tx per block, 10s delay

      // Mine a new block to reset MEV counters after setup
      await ethers.provider.send('evm_mine', []);

      const swaps = [
        {
          path: [baseAddr, tokenAAddr, baseAddr],
          fees: [30, 30],
          amountIn: ethers.parseEther('100'),
          minAmountOut: ethers.parseEther('95'),
          deadline: deadline,
          recipient: owner.address
        }
      ];

      // Turn off automine to execute multiple transactions in same block
      await ethers.provider.send('evm_setAutomine', [false]);

      // Queue three transactions
      const tx1 = await bofhContract.executeBatchSwaps(swaps);
      const tx2 = await bofhContract.executeBatchSwaps(swaps);
      const tx3 = await bofhContract.executeBatchSwaps(swaps);

      // Mine block to include all three
      await ethers.provider.send('evm_mine', []);

      // Wait for transactions
      await tx1.wait();
      await tx2.wait();
      await tx3.wait();

      // Re-enable automine
      await ethers.provider.send('evm_setAutomine', [true]);

      // Fourth batch in new block should fail due to rate limit (10s delay)
      await expect(
        bofhContract.executeBatchSwaps(swaps)
      ).to.be.revertedWithCustomError(bofhContract, 'RateLimitExceeded');
    });
  });

  describe('Different Path Lengths', function () {
    it('should execute batch with mixed path lengths', async function () {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const baseAddr = await baseToken.getAddress();
      const tokenAAddr = await tokenA.getAddress();
      const tokenBAddr = await tokenB.getAddress();

      const swaps = [
        {
          // 2-hop path
          path: [baseAddr, tokenAAddr, baseAddr],
          fees: [30, 30],
          amountIn: ethers.parseEther('100'),
          minAmountOut: ethers.parseEther('95'),
          deadline: deadline,
          recipient: owner.address
        },
        {
          // 3-hop path
          path: [baseAddr, tokenAAddr, tokenBAddr, baseAddr],
          fees: [30, 30, 30],
          amountIn: ethers.parseEther('100'),
          minAmountOut: ethers.parseEther('90'),
          deadline: deadline,
          recipient: owner.address
        }
      ];

      const outputs = await bofhContract.executeBatchSwaps.staticCall(swaps);
      await bofhContract.executeBatchSwaps(swaps);

      expect(outputs.length).to.equal(2);
      expect(outputs[0]).to.be.greaterThan(0);
      expect(outputs[1]).to.be.greaterThan(0);
    });
  });
});
