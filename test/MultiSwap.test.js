const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("Multi-Swap Execution Tests", function () {
  async function deployContractsFixture() {
    const [owner, user1, user2] = await ethers.getSigners();

    // Deploy mock tokens
    const MockToken = await ethers.getContractFactory("MockToken");
    const baseToken = await MockToken.deploy("Base Token", "BASE", ethers.parseEther("1000000"));
    const tokenA = await MockToken.deploy("Token A", "TKNA", ethers.parseEther("1000000"));
    const tokenB = await MockToken.deploy("Token B", "TKNB", ethers.parseEther("1000000"));
    const tokenC = await MockToken.deploy("Token C", "TKNC", ethers.parseEther("1000000"));

    // Deploy factory
    const MockFactory = await ethers.getContractFactory("MockFactory");
    const factory = await MockFactory.deploy();

    // Create pairs (pairs are symmetric in Uniswap V2, so BASE-A is same as A-BASE)
    await factory.createPair(await baseToken.getAddress(), await tokenA.getAddress());
    await factory.createPair(await tokenA.getAddress(), await tokenB.getAddress());
    await factory.createPair(await baseToken.getAddress(), await tokenB.getAddress());
    await factory.createPair(await baseToken.getAddress(), await tokenC.getAddress());

    const pairBaseA = await factory.getPair(await baseToken.getAddress(), await tokenA.getAddress());
    const pairAB = await factory.getPair(await tokenA.getAddress(), await tokenB.getAddress());
    const pairBaseB = await factory.getPair(await baseToken.getAddress(), await tokenB.getAddress());
    const pairBaseC = await factory.getPair(await baseToken.getAddress(), await tokenC.getAddress());

    const MockPair = await ethers.getContractFactory("MockPair");
    const pairBaseAContract = MockPair.attach(pairBaseA);
    const pairABContract = MockPair.attach(pairAB);
    const pairBaseBContract = MockPair.attach(pairBaseB);
    const pairBaseCContract = MockPair.attach(pairBaseC);

    // Add liquidity to create price discrepancies for arbitrage testing
    const liquidityBase = ethers.parseEther("10000");
    const liquidityOther = ethers.parseEther("5000");

    await baseToken.transfer(pairBaseA, liquidityBase);
    await tokenA.transfer(pairBaseA, liquidityOther);
    await pairBaseAContract.sync();

    await tokenA.transfer(pairAB, liquidityOther);
    await tokenB.transfer(pairAB, liquidityOther);
    await pairABContract.sync();

    await tokenB.transfer(pairBaseB, liquidityOther);
    await baseToken.transfer(pairBaseB, liquidityBase);
    await pairBaseBContract.sync();

    await baseToken.transfer(pairBaseC, liquidityBase);
    await tokenC.transfer(pairBaseC, liquidityOther);
    await pairBaseCContract.sync();

    // Deploy BofhContractV2
    const BofhContractV2 = await ethers.getContractFactory("BofhContractV2");
    const bofh = await BofhContractV2.deploy(
      await baseToken.getAddress(),
      await factory.getAddress()
    );

    // Fund users
    await baseToken.transfer(user1.address, ethers.parseEther("1000"));
    await baseToken.transfer(user2.address, ethers.parseEther("1000"));

    // Approve
    await baseToken.connect(user1).approve(await bofh.getAddress(), ethers.MaxUint256);
    await baseToken.connect(user2).approve(await bofh.getAddress(), ethers.MaxUint256);

    return {
      bofh,
      baseToken,
      tokenA,
      tokenB,
      tokenC,
      factory,
      owner,
      user1,
      user2
    };
  }

  describe("Profitability Enforcement", function () {
    // NOTE: executeMultiSwap enforces totalOutput > totalInput for all multi-path swaps.
    // This is a design decision for arbitrage-focused execution.
    // Simple round-trip swaps (BASE → X → BASE) always lose money to fees (0.3% per hop).

    it("Should reject unprofitable 2-path execution", async function () {
      const { bofh, baseToken, tokenA, tokenB, user1 } = await loadFixture(deployContractsFixture);

      const paths = [
        [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()],
        [await baseToken.getAddress(), await tokenB.getAddress(), await baseToken.getAddress()]
      ];
      const fees = [[30, 30], [30, 30]];
      const amounts = [ethers.parseEther("1"), ethers.parseEther("1")];
      const minAmounts = [ethers.parseEther("0.1"), ethers.parseEther("0.1")];
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      // Should revert because round-trips lose money to fees
      await expect(
        bofh.connect(user1).executeMultiSwap(paths, fees, amounts, minAmounts, deadline)
      ).to.be.revertedWithCustomError(bofh, "UnprofitableExecution");
    });

    it("Should reject unprofitable 3-path execution", async function () {
      const { bofh, baseToken, tokenA, tokenB, tokenC, user1 } = await loadFixture(deployContractsFixture);

      const paths = [
        [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()],
        [await baseToken.getAddress(), await tokenB.getAddress(), await baseToken.getAddress()],
        [await baseToken.getAddress(), await tokenC.getAddress(), await baseToken.getAddress()]
      ];
      const fees = [[30, 30], [30, 30], [30, 30]];
      const amounts = [
        ethers.parseEther("1"),
        ethers.parseEther("1"),
        ethers.parseEther("1")
      ];
      const minAmounts = [
        ethers.parseEther("0.1"),
        ethers.parseEther("0.1"),
        ethers.parseEther("0.1")
      ];
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      await expect(
        bofh.connect(user1).executeMultiSwap(paths, fees, amounts, minAmounts, deadline)
      ).to.be.revertedWithCustomError(bofh, "UnprofitableExecution");
    });

    it("Should reject unprofitable single path", async function () {
      const { bofh, baseToken, tokenA, user1 } = await loadFixture(deployContractsFixture);

      const paths = [
        [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()]
      ];
      const fees = [[30, 30]];
      const amounts = [ethers.parseEther("10")];
      const minAmounts = [ethers.parseEther("1")];
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      await expect(
        bofh.connect(user1).executeMultiSwap(paths, fees, amounts, minAmounts, deadline)
      ).to.be.revertedWithCustomError(bofh, "UnprofitableExecution");
    });
  });

  describe("Input Validation", function () {
    it("Should reject empty paths array", async function () {
      const { bofh, user1 } = await loadFixture(deployContractsFixture);

      const deadline = Math.floor(Date.now() / 1000) + 3600;

      await expect(
        bofh.connect(user1).executeMultiSwap([], [], [], [], deadline)
      ).to.be.reverted;
    });

    it("Should reject mismatched array lengths (paths vs fees)", async function () {
      const { bofh, baseToken, tokenA, user1 } = await loadFixture(deployContractsFixture);

      const paths = [
        [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()]
      ];
      const fees = [[30, 30], [30, 30]]; // Wrong length
      const amounts = [ethers.parseEther("10")];
      const minAmounts = [ethers.parseEther("1")];
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      await expect(
        bofh.connect(user1).executeMultiSwap(paths, fees, amounts, minAmounts, deadline)
      ).to.be.reverted;
    });

    it("Should reject mismatched array lengths (paths vs amounts)", async function () {
      const { bofh, baseToken, tokenA, user1 } = await loadFixture(deployContractsFixture);

      const paths = [
        [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()]
      ];
      const fees = [[30, 30]];
      const amounts = [ethers.parseEther("10"), ethers.parseEther("10")]; // Wrong length
      const minAmounts = [ethers.parseEther("1")];
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      await expect(
        bofh.connect(user1).executeMultiSwap(paths, fees, amounts, minAmounts, deadline)
      ).to.be.reverted;
    });

    it("Should reject mismatched array lengths (paths vs minAmounts)", async function () {
      const { bofh, baseToken, tokenA, user1 } = await loadFixture(deployContractsFixture);

      const paths = [
        [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()]
      ];
      const fees = [[30, 30]];
      const amounts = [ethers.parseEther("10")];
      const minAmounts = [ethers.parseEther("1"), ethers.parseEther("1")]; // Wrong length
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      await expect(
        bofh.connect(user1).executeMultiSwap(paths, fees, amounts, minAmounts, deadline)
      ).to.be.reverted;
    });

    it("Should reject expired deadline", async function () {
      const { bofh, baseToken, tokenA, user1 } = await loadFixture(deployContractsFixture);

      const paths = [
        [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()]
      ];
      const fees = [[30, 30]];
      const amounts = [ethers.parseEther("10")];
      const minAmounts = [ethers.parseEther("1")];
      const pastDeadline = Math.floor(Date.now() / 1000) - 100;

      await expect(
        bofh.connect(user1).executeMultiSwap(paths, fees, amounts, minAmounts, pastDeadline)
      ).to.be.reverted;
    });

    it("Should reject zero deadline", async function () {
      const { bofh, baseToken, tokenA, user1 } = await loadFixture(deployContractsFixture);

      const paths = [
        [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()]
      ];
      const fees = [[30, 30]];
      const amounts = [ethers.parseEther("10")];
      const minAmounts = [ethers.parseEther("1")];

      await expect(
        bofh.connect(user1).executeMultiSwap(paths, fees, amounts, minAmounts, 0)
      ).to.be.reverted;
    });
  });

  describe("Edge Cases", function () {
    it("Should handle different path lengths in parallel", async function () {
      const { bofh, baseToken, tokenA, tokenB, user1 } = await loadFixture(deployContractsFixture);

      // Path 1: 2-hop (BASE → A → BASE)
      // Path 2: 3-hop (BASE → A → B → BASE)
      const paths = [
        [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()],
        [await baseToken.getAddress(), await tokenA.getAddress(), await tokenB.getAddress(), await baseToken.getAddress()]
      ];
      const fees = [
        [30, 30],
        [30, 30, 30]
      ];
      const amounts = [ethers.parseEther("10"), ethers.parseEther("10")];
      const minAmounts = [ethers.parseEther("1"), ethers.parseEther("1")];
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      // Will revert due to unprofitability, but tests path length handling
      await expect(
        bofh.connect(user1).executeMultiSwap(paths, fees, amounts, minAmounts, deadline)
      ).to.be.revertedWithCustomError(bofh, "UnprofitableExecution");
    });
  });
});
