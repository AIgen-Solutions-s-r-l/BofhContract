const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Pool blacklist enforcement (FIX B).
 *
 * blacklistedPools is set by setPoolBlacklist but was previously read ONLY by the
 * isPoolBlacklisted getter and NEVER enforced in any swap path. These tests assert the
 * blacklist is now enforced at pair resolution (inside executePathStep) so it covers BOTH
 * the legacy executeSwap and the multi-DEX executeSwapMultiDex paths, reverting with the
 * dedicated PoolIsBlacklisted error and succeeding again once un-blacklisted.
 */
describe("Pool Blacklist Enforcement", function () {
  const MAX_UINT256 = ethers.MaxUint256;

  async function deployFixture() {
    const [owner, user1] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockToken");
    const baseToken = await MockToken.deploy("Base Token", "BASE", ethers.parseEther("100000000"));
    const tokenA = await MockToken.deploy("Token A", "TKNA", ethers.parseEther("100000000"));

    // Two independent factories model two DEXes (dexId 0 = constructor, dexId 1 = registered).
    const MockFactory = await ethers.getContractFactory("MockFactory");
    const factory0 = await MockFactory.deploy();
    const factory1 = await MockFactory.deploy();

    const baseAddr = await baseToken.getAddress();
    const aAddr = await tokenA.getAddress();

    await factory0.createPair(baseAddr, aAddr);
    await factory1.createPair(baseAddr, aAddr);

    const pair0Addr = await factory0.getPair(baseAddr, aAddr);
    const pair1Addr = await factory1.getPair(baseAddr, aAddr);

    const MockPair = await ethers.getContractFactory("MockPair");
    const pair0 = MockPair.attach(pair0Addr);
    const pair1 = MockPair.attach(pair1Addr);

    const liquidity = ethers.parseEther("1000000");

    await baseToken.transfer(pair0Addr, liquidity);
    await tokenA.transfer(pair0Addr, liquidity);
    await pair0.sync();
    await pair0.setSwapFee(30);

    await baseToken.transfer(pair1Addr, liquidity);
    await tokenA.transfer(pair1Addr, liquidity);
    await pair1.sync();
    await pair1.setSwapFee(25);

    const BofhContractV2 = await ethers.getContractFactory("BofhContractV2");
    const bofh = await BofhContractV2.deploy(baseAddr, await factory0.getAddress());

    // Register dexId 1 for the multi-DEX path.
    await bofh.connect(owner).setDex(1, await factory1.getAddress(), 25, true);

    await baseToken.transfer(user1.address, ethers.parseEther("1000000"));
    await baseToken.connect(user1).approve(await bofh.getAddress(), MAX_UINT256);

    return {
      owner, user1, bofh, baseToken, tokenA,
      baseAddr, aAddr, pair0Addr, pair1Addr,
    };
  }

  async function deadlineFromNow() {
    return (await ethers.provider.getBlock("latest")).timestamp + 3600;
  }

  describe("executeSwap (legacy single-DEX)", function () {
    it("reverts with PoolIsBlacklisted when a pair on the path is blacklisted, succeeds after un-blacklisting", async function () {
      const { owner, user1, bofh, baseAddr, aAddr, pair0Addr } = await loadFixture(deployFixture);

      const path = [baseAddr, aAddr, baseAddr];
      const fees = [30, 30];
      const amountIn = ethers.parseEther("1000");
      const deadline = await deadlineFromNow();

      // Sanity: swap works before blacklisting.
      await expect(
        bofh.connect(user1).executeSwap(path, fees, amountIn, 1n, deadline)
      ).to.not.be.reverted;

      // Blacklist the only pair used by this path (BASE/A on factory0).
      await bofh.connect(owner).setPoolBlacklist(pair0Addr, true);
      expect(await bofh.isPoolBlacklisted(pair0Addr)).to.be.true;

      // Now the swap MUST revert at pair resolution with the dedicated error.
      await expect(
        bofh.connect(user1).executeSwap(path, fees, amountIn, 1n, await deadlineFromNow())
      ).to.be.revertedWithCustomError(bofh, "PoolIsBlacklisted").withArgs(pair0Addr);

      // Un-blacklist and confirm the swap succeeds again.
      await bofh.connect(owner).setPoolBlacklist(pair0Addr, false);
      expect(await bofh.isPoolBlacklisted(pair0Addr)).to.be.false;

      await expect(
        bofh.connect(user1).executeSwap(path, fees, amountIn, 1n, await deadlineFromNow())
      ).to.not.be.reverted;
    });
  });

  describe("executeSwapMultiDex", function () {
    it("reverts with PoolIsBlacklisted when a hop pair is blacklisted, succeeds after un-blacklisting", async function () {
      const { owner, user1, bofh, baseAddr, aAddr, pair1Addr } = await loadFixture(deployFixture);

      // hop0 via dexId 0 (factory0 pair), hop1 via dexId 1 (factory1 pair).
      const path = [baseAddr, aAddr, baseAddr];
      const fees = [30, 25];
      const dexIds = [0, 1];
      const amountIn = ethers.parseEther("1000");

      // Sanity: multi-DEX swap works before blacklisting.
      await expect(
        bofh.connect(user1).executeSwapMultiDex(path, fees, dexIds, amountIn, 1n, await deadlineFromNow())
      ).to.not.be.reverted;

      // Blacklist the dexId-1 pair used by hop1 (BASE/A on factory1).
      await bofh.connect(owner).setPoolBlacklist(pair1Addr, true);

      await expect(
        bofh.connect(user1).executeSwapMultiDex(path, fees, dexIds, amountIn, 1n, await deadlineFromNow())
      ).to.be.revertedWithCustomError(bofh, "PoolIsBlacklisted").withArgs(pair1Addr);

      // Un-blacklist and confirm success.
      await bofh.connect(owner).setPoolBlacklist(pair1Addr, false);

      await expect(
        bofh.connect(user1).executeSwapMultiDex(path, fees, dexIds, amountIn, 1n, await deadlineFromNow())
      ).to.not.be.reverted;
    });
  });

  describe("executeBatchSwaps", function () {
    it("reverts with PoolIsBlacklisted when a batched swap routes through a blacklisted pair", async function () {
      const { owner, user1, bofh, baseAddr, aAddr, pair0Addr } = await loadFixture(deployFixture);

      const swap = {
        path: [baseAddr, aAddr, baseAddr],
        fees: [30, 30],
        amountIn: ethers.parseEther("1000"),
        minAmountOut: 1n,
        deadline: await deadlineFromNow(),
        recipient: user1.address,
      };

      // Sanity: the batch works before blacklisting.
      await expect(bofh.connect(user1).executeBatchSwaps([swap])).to.not.be.reverted;

      // The blacklist is enforced at the shared chokepoint (executePathStep), so the batch path
      // reverts too once the path's pair is blacklisted.
      await bofh.connect(owner).setPoolBlacklist(pair0Addr, true);
      await expect(
        bofh.connect(user1).executeBatchSwaps([{ ...swap, deadline: await deadlineFromNow() }])
      ).to.be.revertedWithCustomError(bofh, "PoolIsBlacklisted").withArgs(pair0Addr);
    });
  });
});
