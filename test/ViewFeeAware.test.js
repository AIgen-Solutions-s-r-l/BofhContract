const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Fee-aware getOptimalPathMetricsWithFees tests (Phase 2).
 *
 * The headline guarantee: the fee-aware view uses the EXACT same constant-product-with-fee
 * formula (and operation order) as executePathStep, so getOptimalPathMetricsWithFees(path, amounts,
 * fees) equals the realized round-trip output of executeSwap to the wei, for any per-hop fee.
 *
 * Also validates: input validation (array length, fee cap, path length) and fee-monotonicity.
 */
describe("Fee-Aware View (getOptimalPathMetricsWithFees)", function () {
  function getAmountOut(amountIn, reserveIn, reserveOut, feeBps) {
    const feeNum = 10000n - BigInt(feeBps);
    const amountInWithFee = amountIn * feeNum;
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 10000n + amountInWithFee;
    return numerator / denominator;
  }

  async function deployFixture() {
    const [owner, user1] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockToken");
    const baseToken = await MockToken.deploy("Base Token", "BASE", ethers.parseEther("100000000"));
    const tokenA = await MockToken.deploy("Token A", "TKNA", ethers.parseEther("100000000"));

    const MockFactory = await ethers.getContractFactory("MockFactory");
    const factory = await MockFactory.deploy();

    const baseAddr = await baseToken.getAddress();
    const aAddr = await tokenA.getAddress();

    await factory.createPair(baseAddr, aAddr);
    const pairAddr = await factory.getPair(baseAddr, aAddr);

    const MockPair = await ethers.getContractFactory("MockPair");
    const pair = MockPair.attach(pairAddr);

    const liquidity = ethers.parseEther("1000000");
    await baseToken.transfer(pairAddr, liquidity);
    await tokenA.transfer(pairAddr, liquidity);
    await pair.sync();

    const BofhContractV2 = await ethers.getContractFactory("BofhContractV2");
    const bofh = await BofhContractV2.deploy(baseAddr, await factory.getAddress());

    await baseToken.transfer(user1.address, ethers.parseEther("1000000"));
    await baseToken.connect(user1).approve(await bofh.getAddress(), ethers.MaxUint256);

    return { owner, user1, bofh, baseToken, tokenA, factory, pair, baseAddr, aAddr, liquidity, getAmountOut };
  }

  async function deadlineFromNow() {
    return (await ethers.provider.getBlock("latest")).timestamp + 3600;
  }

  describe("view == exec (the headline)", function () {
    // For each pool fee, the fee-aware view must equal the realized round-trip output of executeSwap.
    for (const fee of [25, 30, 50]) {
      it(`getOptimalPathMetrics(fees=[${fee},${fee}]) equals realized executeSwap output`, async function () {
        const { bofh, user1, baseToken, pair, baseAddr, aAddr } = await loadFixture(deployFixture);

        await pair.setSwapFee(fee);

        const path = [baseAddr, aAddr, baseAddr];
        const fees = [fee, fee];
        const amountIn = ethers.parseEther("1000");

        // View: fee-aware expected output (no state change).
        const [expectedOutput] = await bofh.getOptimalPathMetricsWithFees(path, [amountIn], fees);

        // Exec: realized round-trip output.
        const balBefore = await baseToken.balanceOf(user1.address);
        await bofh.connect(user1).executeSwap(path, fees, amountIn, 1n, await deadlineFromNow());
        const balAfter = await baseToken.balanceOf(user1.address);
        const realized = balAfter - balBefore + amountIn;

        expect(expectedOutput).to.equal(realized);
      });
    }
  });

  describe("validation", function () {
    it("rejects fees.length != path.length-1 (InvalidArrayLength)", async function () {
      const { bofh, baseAddr, aAddr } = await loadFixture(deployFixture);
      const path = [baseAddr, aAddr, baseAddr];
      await expect(
        bofh.getOptimalPathMetricsWithFees(path, [ethers.parseEther("10")], [30]) // needs 2 fees
      ).to.be.revertedWithCustomError(bofh, "InvalidArrayLength");
    });

    it("rejects fees[i] > MAX_FEE_BPS (InvalidFee)", async function () {
      const { bofh, baseAddr, aAddr } = await loadFixture(deployFixture);
      const path = [baseAddr, aAddr, baseAddr];
      await expect(
        bofh.getOptimalPathMetricsWithFees(path, [ethers.parseEther("10")], [1001, 30])
      ).to.be.revertedWithCustomError(bofh, "InvalidFee");
    });

    it("rejects path length < 2 (InvalidPath)", async function () {
      const { bofh, baseAddr } = await loadFixture(deployFixture);
      await expect(
        bofh.getOptimalPathMetricsWithFees([baseAddr], [ethers.parseEther("10")], [])
      ).to.be.revertedWithCustomError(bofh, "InvalidPath");
    });

    it("rejects path length > MAX_PATH_LENGTH (InvalidPath)", async function () {
      const { bofh, baseAddr, aAddr } = await loadFixture(deployFixture);
      // 7 tokens > MAX_PATH_LENGTH (6)
      const path = [baseAddr, aAddr, baseAddr, aAddr, baseAddr, aAddr, baseAddr];
      await expect(
        bofh.getOptimalPathMetricsWithFees(path, [ethers.parseEther("10")], [30, 30, 30, 30, 30, 30])
      ).to.be.revertedWithCustomError(bofh, "InvalidPath");
    });
  });

  describe("fee monotonicity & self-consistency", function () {
    it("lower fee yields strictly more output: [25] > [30] > [50]", async function () {
      const { bofh, baseAddr, aAddr } = await loadFixture(deployFixture);
      const path = [baseAddr, aAddr];
      const amounts = [ethers.parseEther("1000")];

      const [out25] = await bofh.getOptimalPathMetricsWithFees(path, amounts, [25]);
      const [out30] = await bofh.getOptimalPathMetricsWithFees(path, amounts, [30]);
      const [out50] = await bofh.getOptimalPathMetricsWithFees(path, amounts, [50]);

      expect(out25).to.be.gt(out30);
      expect(out30).to.be.gt(out50);
    });

    it("optimalityScore equals (expectedOutput * 1e6) / amounts[0]", async function () {
      const { bofh, baseAddr, aAddr } = await loadFixture(deployFixture);
      const path = [baseAddr, aAddr];
      const amounts = [ethers.parseEther("1000")];

      const [expectedOutput, , optimalityScore] = await bofh.getOptimalPathMetricsWithFees(path, amounts, [30]);
      const PRECISION = 1000000n;
      expect(optimalityScore).to.equal((expectedOutput * PRECISION) / amounts[0]);
    });
  });
});
