const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Multi-DEX routing tests (Phase 2).
 *
 * One router deployment routes hops through DIFFERENT V2-fork DEXes by selecting a per-hop
 * factory via dexIds[]. dexId 0 is the reserved immutable factory; dexId > 0 is resolved from
 * the on-chain DexRegistry (setDex). Pricing stays caller-authoritative via fees[], with an
 * opt-in registry-fee sentinel (fees[i] == type(uint256).max).
 *
 * The token-flow (pre-fund -> IGenericPair.swap -> balanceOf delta) is unchanged; only WHICH
 * pair address swap() is called on differs per hop.
 */
describe("Multi-DEX Routing", function () {
  const MAX_UINT256 = ethers.MaxUint256;

  // Constant-product amount-out, identical to executePathStep's formula.
  function getAmountOut(amountIn, reserveIn, reserveOut, feeBps) {
    const feeNum = 10000n - BigInt(feeBps);
    const amountInWithFee = amountIn * feeNum;
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 10000n + amountInWithFee;
    return numerator / denominator;
  }

  async function deployFixture() {
    const [owner, user1, attacker] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockToken");
    const baseToken = await MockToken.deploy("Base Token", "BASE", ethers.parseEther("100000000"));
    const tokenA = await MockToken.deploy("Token A", "TKNA", ethers.parseEther("100000000"));

    // Two independent factories model two DEXes (e.g. Pancake vs Sushi).
    const MockFactory = await ethers.getContractFactory("MockFactory");
    const factory0 = await MockFactory.deploy(); // dexId 0 (constructor factory)
    const factory1 = await MockFactory.deploy(); // dexId 1 (registered via setDex)

    const baseAddr = await baseToken.getAddress();
    const aAddr = await tokenA.getAddress();

    await factory0.createPair(baseAddr, aAddr);
    await factory1.createPair(baseAddr, aAddr);

    const pair0Addr = await factory0.getPair(baseAddr, aAddr);
    const pair1Addr = await factory1.getPair(baseAddr, aAddr);

    const MockPair = await ethers.getContractFactory("MockPair");
    const pair0 = MockPair.attach(pair0Addr);
    const pair1 = MockPair.attach(pair1Addr);

    // Symmetric, deep liquidity on both pools so the round-trip only loses to fees.
    const liquidity = ethers.parseEther("1000000");

    await baseToken.transfer(pair0Addr, liquidity);
    await tokenA.transfer(pair0Addr, liquidity);
    await pair0.sync();

    await baseToken.transfer(pair1Addr, liquidity);
    await tokenA.transfer(pair1Addr, liquidity);
    await pair1.sync();

    // dexId 0 default fee is 0.3% -> set pool 0 to 30. dexId 1 emulates Pancake 0.25% -> 25.
    await pair0.setSwapFee(30);
    await pair1.setSwapFee(25);

    const BofhContractV2 = await ethers.getContractFactory("BofhContractV2");
    const bofh = await BofhContractV2.deploy(baseAddr, await factory0.getAddress());

    // Register dexId 1 with feeBps 25 (Pancake-style).
    await bofh.connect(owner).setDex(1, await factory1.getAddress(), 25, true);

    await baseToken.transfer(user1.address, ethers.parseEther("1000000"));
    await baseToken.connect(user1).approve(await bofh.getAddress(), MAX_UINT256);

    return {
      owner, user1, attacker,
      bofh, baseToken, tokenA,
      factory0, factory1,
      pair0, pair1, pair0Addr, pair1Addr,
      baseAddr, aAddr,
      liquidity,
      getAmountOut,
    };
  }

  async function deadlineFromNow() {
    return (await ethers.provider.getBlock("latest")).timestamp + 3600;
  }

  describe("Cross-DEX routing", function () {
    it("routes hop 0 through dexId 0 and hop 1 through dexId 1 (different pairs, per-hop fees)", async function () {
      const { bofh, user1, baseAddr, aAddr, pair0Addr, pair1Addr, liquidity, getAmountOut } =
        await loadFixture(deployFixture);

      // Sanity: the two DEXes resolve to DIFFERENT pair addresses for the same token pair.
      expect(pair0Addr).to.not.equal(pair1Addr);

      const path = [baseAddr, aAddr, baseAddr];
      const fees = [30, 25];      // hop0 prices at dexId0's 0.3%, hop1 at dexId1's 0.25%
      const dexIds = [0, 1];
      const amountIn = ethers.parseEther("1000");
      const deadline = await deadlineFromNow();

      // Hop 0 on pool 0 (BASE->A at 0.3%): reserves are symmetric `liquidity`/`liquidity`.
      const out1 = getAmountOut(amountIn, liquidity, liquidity, 30);
      // Hop 1 on pool 1 (A->BASE at 0.25%): pool 1 is untouched, so reserves are still symmetric.
      const out2 = getAmountOut(out1, liquidity, liquidity, 25);

      const base = await ethers.getContractAt("MockToken", baseAddr);
      const tokenBalBefore = await base.balanceOf(user1.address);
      await expect(
        bofh.connect(user1).executeSwapMultiDex(path, fees, dexIds, amountIn, 1n, deadline)
      ).to.not.be.reverted;
      const tokenBalAfter = await base.balanceOf(user1.address);

      const realizedOutput = tokenBalAfter - tokenBalBefore + amountIn;
      expect(realizedOutput).to.equal(out2);
    });

    it("getOptimalPathMetricsMultiDex matches executeSwapMultiDex for dexIds=[0,1]", async function () {
      const { bofh, user1, baseToken, baseAddr, aAddr } = await loadFixture(deployFixture);

      const path = [baseAddr, aAddr, baseAddr];
      const fees = [30, 25];
      const dexIds = [0, 1];
      const amountIn = ethers.parseEther("500");
      const deadline = await deadlineFromNow();

      const [expectedOutput] = await bofh.getOptimalPathMetricsMultiDex(path, [amountIn], dexIds, fees);

      const balBefore = await baseToken.balanceOf(user1.address);
      await bofh.connect(user1).executeSwapMultiDex(path, fees, dexIds, amountIn, 1n, deadline);
      const balAfter = await baseToken.balanceOf(user1.address);
      const realized = balAfter - balBefore + amountIn;

      expect(realized).to.equal(expectedOutput);
    });
  });

  describe("Registry access control", function () {
    it("setDex from non-owner reverts", async function () {
      const { bofh, attacker, factory1 } = await loadFixture(deployFixture);
      await expect(
        bofh.connect(attacker).setDex(2, await factory1.getAddress(), 30, true)
      ).to.be.reverted;
    });

    it("setDex(0,...) reverts DexAlreadyReserved", async function () {
      const { bofh, owner, factory1 } = await loadFixture(deployFixture);
      await expect(
        bofh.connect(owner).setDex(0, await factory1.getAddress(), 30, true)
      ).to.be.revertedWithCustomError(bofh, "DexAlreadyReserved");
    });

    it("setDex with zero factory reverts InvalidDexFactory", async function () {
      const { bofh, owner } = await loadFixture(deployFixture);
      await expect(
        bofh.connect(owner).setDex(3, ethers.ZeroAddress, 30, true)
      ).to.be.revertedWithCustomError(bofh, "InvalidDexFactory");
    });

    it("setDex with feeBps > MAX_FEE_BPS (1000) reverts InvalidFee", async function () {
      const { bofh, owner, factory1 } = await loadFixture(deployFixture);
      await expect(
        bofh.connect(owner).setDex(4, await factory1.getAddress(), 1001, true)
      ).to.be.revertedWithCustomError(bofh, "InvalidFee");
    });

    it("getDex returns the stored {factory, feeBps, enabled}", async function () {
      const { bofh, factory1 } = await loadFixture(deployFixture);
      const [factory, feeBps, enabled] = await bofh.getDex(1);
      expect(factory).to.equal(await factory1.getAddress());
      expect(feeBps).to.equal(25);
      expect(enabled).to.equal(true);
    });

    it("executeSwapMultiDex with an unregistered dexId reverts DexNotRegistered", async function () {
      const { bofh, user1, baseAddr, aAddr } = await loadFixture(deployFixture);
      const path = [baseAddr, aAddr, baseAddr];
      const deadline = await deadlineFromNow();
      await expect(
        bofh.connect(user1).executeSwapMultiDex(path, [30, 30], [0, 9], ethers.parseEther("100"), 1n, deadline)
      ).to.be.revertedWithCustomError(bofh, "DexNotRegistered");
    });

    it("executeSwapMultiDex with a disabled dexId reverts DexNotRegistered", async function () {
      const { bofh, owner, user1, factory1, baseAddr, aAddr } = await loadFixture(deployFixture);
      // Register dexId 5 then disable it.
      await bofh.connect(owner).setDex(5, await factory1.getAddress(), 25, false);
      const path = [baseAddr, aAddr, baseAddr];
      const deadline = await deadlineFromNow();
      await expect(
        bofh.connect(user1).executeSwapMultiDex(path, [30, 25], [0, 5], ethers.parseEther("100"), 1n, deadline)
      ).to.be.revertedWithCustomError(bofh, "DexNotRegistered");
    });

    it("executeSwapMultiDex with dexIds.length != path.length-1 reverts InvalidArrayLength", async function () {
      const { bofh, user1, baseAddr, aAddr } = await loadFixture(deployFixture);
      const path = [baseAddr, aAddr, baseAddr];
      const deadline = await deadlineFromNow();
      await expect(
        bofh.connect(user1).executeSwapMultiDex(path, [30, 25], [0], ethers.parseEther("100"), 1n, deadline)
      ).to.be.revertedWithCustomError(bofh, "InvalidArrayLength");
    });
  });

  describe("Fee-resolution sentinel", function () {
    it("fees[i] == type(uint256).max uses the registry feeBps for that hop", async function () {
      const { bofh, user1, baseToken, baseAddr, aAddr, liquidity, getAmountOut } =
        await loadFixture(deployFixture);

      const path = [baseAddr, aAddr, baseAddr];
      // hop0 explicit 0.3% on dexId0; hop1 sentinel -> uses dexId1's registry fee (25).
      const fees = [30, MAX_UINT256];
      const dexIds = [0, 1];
      const amountIn = ethers.parseEther("1000");
      const deadline = await deadlineFromNow();

      const out1 = getAmountOut(amountIn, liquidity, liquidity, 30);
      const out2 = getAmountOut(out1, liquidity, liquidity, 25); // 25 = registry fee for dexId 1

      const balBefore = await baseToken.balanceOf(user1.address);
      await bofh.connect(user1).executeSwapMultiDex(path, fees, dexIds, amountIn, 1n, deadline);
      const balAfter = await baseToken.balanceOf(user1.address);
      const realized = balAfter - balBefore + amountIn;

      expect(realized).to.equal(out2);
    });

    it("explicit fees[i] wins over the registry fee", async function () {
      const { bofh, owner, user1, baseToken, factory1, pair1, baseAddr, aAddr, liquidity, getAmountOut } =
        await loadFixture(deployFixture);

      // Re-register dexId 1 with a registry fee of 25, but the POOL actually charges 30:
      // set the pool to 30 and price the caller EXPLICITLY at 30 (overriding the registry's 25).
      await pair1.setSwapFee(30);
      await bofh.connect(owner).setDex(1, await factory1.getAddress(), 25, true);

      const path = [baseAddr, aAddr, baseAddr];
      const fees = [30, 30]; // explicit 30 on both hops, NOT the registry's 25
      const dexIds = [0, 1];
      const amountIn = ethers.parseEther("1000");
      const deadline = await deadlineFromNow();

      const out1 = getAmountOut(amountIn, liquidity, liquidity, 30);
      const out2 = getAmountOut(out1, liquidity, liquidity, 30); // caller's 30 used, not 25

      const balBefore = await baseToken.balanceOf(user1.address);
      await bofh.connect(user1).executeSwapMultiDex(path, fees, dexIds, amountIn, 1n, deadline);
      const balAfter = await baseToken.balanceOf(user1.address);
      const realized = balAfter - balBefore + amountIn;

      expect(realized).to.equal(out2);
    });
  });

  describe("Backward parity (dexId 0 only)", function () {
    it("executeSwapMultiDex with all dexId 0 equals legacy executeSwap output", async function () {
      const { bofh, user1, baseToken, baseAddr, aAddr } = await loadFixture(deployFixture);

      const path = [baseAddr, aAddr, baseAddr];
      const amountIn = ethers.parseEther("1000");
      const deadline1 = await deadlineFromNow();

      // Legacy single-DEX path
      const balBefore1 = await baseToken.balanceOf(user1.address);
      await bofh.connect(user1).executeSwap(path, [30, 30], amountIn, 1n, deadline1);
      const legacyOut = (await baseToken.balanceOf(user1.address)) - balBefore1 + amountIn;

      // Reset reserves by re-loading the fixture would change pools; instead just compare to a
      // fresh fixture's multi-DEX dexId-0 run on identical untouched pools.
      const fresh = await loadFixture(deployFixture);
      const balBefore2 = await fresh.baseToken.balanceOf(fresh.user1.address);
      await fresh.bofh.connect(fresh.user1).executeSwapMultiDex(
        [fresh.baseAddr, fresh.aAddr, fresh.baseAddr], [30, 30], [0, 0], amountIn, 1n, await deadlineFromNow()
      );
      const multiOut = (await fresh.baseToken.balanceOf(fresh.user1.address)) - balBefore2 + amountIn;

      expect(multiOut).to.equal(legacyOut);
    });
  });
});
