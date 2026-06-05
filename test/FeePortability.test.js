const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Fee-portability tests for the "fee fix".
 *
 * The router used to hardcode the 0.3% (997/1000) AMM fee. It now consumes the
 * per-hop `fees[i]` (basis points out of 10000), so it prices correctly on DEXes
 * with other fees (Pancake 0.25%, Uniswap 0.3%, higher-fee forks).
 *
 * These tests deploy MockToken / MockFactory / MockPair, fund pools, set the
 * MockPair swapFee to emulate a given DEX, and verify:
 *   (a) a 0.25% pair priced at feeBps=25 swaps successfully (no K-revert) and the
 *       realized output equals the contract's constant-product amount-out;
 *   (b) a 0.5% pair priced at feeBps=30 (too low) requests more than x*y=k allows
 *       and reverts;
 *   (c) the SAME path/amount through a 0.25% pool yields MORE than through a 0.30%
 *       pool (fee sensitivity).
 */
describe("Fee Portability (per-hop fee consumption)", function () {
  // Constant-product amount-out, identical to the formula the router computes
  // in executePathStep: amountOut = (amountIn * (10000-feeBps) * reserveOut) /
  //                                 (reserveIn * 10000 + amountIn * (10000-feeBps))
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
    // tokenA reachable via the "0.25% / variable-fee" pool, tokenB via a fixed 0.30% pool
    const tokenA = await MockToken.deploy("Token A", "TKNA", ethers.parseEther("100000000"));
    const tokenB = await MockToken.deploy("Token B", "TKNB", ethers.parseEther("100000000"));

    const MockFactory = await ethers.getContractFactory("MockFactory");
    const factory = await MockFactory.deploy();

    await factory.createPair(await baseToken.getAddress(), await tokenA.getAddress());
    await factory.createPair(await baseToken.getAddress(), await tokenB.getAddress());

    const pairBaseAAddr = await factory.getPair(await baseToken.getAddress(), await tokenA.getAddress());
    const pairBaseBAddr = await factory.getPair(await baseToken.getAddress(), await tokenB.getAddress());

    const MockPair = await ethers.getContractFactory("MockPair");
    const pairBaseA = MockPair.attach(pairBaseAAddr);
    const pairBaseB = MockPair.attach(pairBaseBAddr);

    // Symmetric, deep liquidity so the round-trip BASE -> X -> BASE only loses to fees
    // (no asymmetric-reserve effects) and so K-checks are well within uint112.
    const liquidity = ethers.parseEther("1000000");

    await baseToken.transfer(pairBaseAAddr, liquidity);
    await tokenA.transfer(pairBaseAAddr, liquidity);
    await pairBaseA.sync();

    await baseToken.transfer(pairBaseBAddr, liquidity);
    await tokenB.transfer(pairBaseBAddr, liquidity);
    await pairBaseB.sync();

    const BofhContractV2 = await ethers.getContractFactory("BofhContractV2");
    const bofh = await BofhContractV2.deploy(
      await baseToken.getAddress(),
      await factory.getAddress()
    );

    await baseToken.transfer(user1.address, ethers.parseEther("100000"));
    await baseToken.connect(user1).approve(await bofh.getAddress(), ethers.MaxUint256);

    return {
      bofh,
      baseToken,
      tokenA,
      tokenB,
      factory,
      pairBaseA,
      pairBaseB,
      pairBaseAAddr,
      liquidity,
      owner,
      user1,
      getAmountOut,
    };
  }

  describe("(a) 0.25% pair priced at feeBps=25", function () {
    it("Should swap successfully and match the contract's constant-product amount-out", async function () {
      const { bofh, baseToken, tokenA, pairBaseA, liquidity, user1 } =
        await loadFixture(deployFixture);

      // Emulate a Pancake-style 0.25% pool.
      await pairBaseA.setSwapFee(25);
      expect(await pairBaseA.swapFee()).to.equal(25);

      const path = [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()];
      const fees = [25, 25]; // price both hops at the pool's true 0.25% fee
      const amountIn = ethers.parseEther("1000");
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;

      // Compute the expected realized output hop-by-hop using the same formula as the router.
      // Hop 1: BASE -> A, reserves (reserveIn=BASE=liquidity, reserveOut=A=liquidity).
      const out1 = getAmountOut(amountIn, liquidity, liquidity, 25);
      // Hop 2: A -> BASE on the SAME pool, reserves updated by hop 1:
      //   the pool gained `amountIn` BASE and lost `out1` A, so now
      //   reserveIn (A) = liquidity - out1, reserveOut (BASE) = liquidity + amountIn.
      const out2 = getAmountOut(out1, liquidity - out1, liquidity + amountIn, 25);

      const balanceBefore = await baseToken.balanceOf(user1.address);
      // Succeeds (no "K" revert) because the requested output respects x*y=k at 0.25%.
      await expect(
        bofh.connect(user1).executeSwap(path, fees, amountIn, 1n, deadline)
      ).to.not.be.reverted;
      const balanceAfter = await baseToken.balanceOf(user1.address);

      // Net delta = realized round-trip output - amountIn spent.
      const realizedOutput = balanceAfter - balanceBefore + amountIn;
      expect(realizedOutput).to.equal(out2);
    });
  });

  describe("(b) 0.5% pair", function () {
    it("priced correctly at feeBps=50 should succeed where the legacy hardcoded-0.3% router could not", async function () {
      const { bofh, baseToken, tokenA, pairBaseA, liquidity, user1 } =
        await loadFixture(deployFixture);

      // Emulate a 0.5% pool and price the caller at its TRUE fee. This is the assertion
      // that DISCRIMINATES the fix from the bug: the old router (hardcoded 997/1000 = 0.3%)
      // would size a 0.3% output and revert "K" on a 0.5% pool; the fee-aware router sizes
      // the output for 0.5% and succeeds.
      await pairBaseA.setSwapFee(50);
      expect(await pairBaseA.swapFee()).to.equal(50);

      const path = [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()];
      const fees = [50, 50];
      const amountIn = ethers.parseEther("1000");
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;

      const out1 = getAmountOut(amountIn, liquidity, liquidity, 50);
      const out2 = getAmountOut(out1, liquidity - out1, liquidity + amountIn, 50);

      const balanceBefore = await baseToken.balanceOf(user1.address);
      await expect(
        bofh.connect(user1).executeSwap(path, fees, amountIn, 1n, deadline)
      ).to.not.be.reverted;
      const balanceAfter = await baseToken.balanceOf(user1.address);

      const realizedOutput = balanceAfter - balanceBefore + amountIn;
      expect(realizedOutput).to.equal(out2);
    });

    it("under-priced at feeBps=30 should revert with \"K\" (router requests more than x*y=k allows)", async function () {
      const { bofh, baseToken, tokenA, pairBaseA, user1 } = await loadFixture(deployFixture);

      // Pool actually charges 0.5%, but the caller prices it as 0.3%: the router computes a
      // 0.3%-sized output the pool's K-invariant won't release, so MockPair.swap() reverts "K".
      await pairBaseA.setSwapFee(50);

      const path = [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()];
      const fees = [30, 30]; // under-priced vs the pool's real 0.5% fee
      const amountIn = ethers.parseEther("1000");
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;

      await expect(
        bofh.connect(user1).executeSwap(path, fees, amountIn, 1n, deadline)
      ).to.be.revertedWith("K");
    });
  });

  describe("(c) Fee sensitivity: 0.25% vs 0.30%", function () {
    it("Should yield MORE output through a 0.25% pool than a 0.30% pool for the same path/amount", async function () {
      const { bofh, baseToken, tokenA, tokenB, pairBaseA, pairBaseB, user1 } =
        await loadFixture(deployFixture);

      const amountIn = ethers.parseEther("1000");
      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;

      // Path via tokenA pool at 0.25%
      await pairBaseA.setSwapFee(25);
      const pathA = [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()];
      const balBeforeA = await baseToken.balanceOf(user1.address);
      await bofh.connect(user1).executeSwap(pathA, [25, 25], amountIn, 1n, deadline);
      const balAfterA = await baseToken.balanceOf(user1.address);
      const outputAt025 = balAfterA - balBeforeA + amountIn;

      // Path via tokenB pool at 0.30% (default), identical reserves
      await pairBaseB.setSwapFee(30);
      const pathB = [await baseToken.getAddress(), await tokenB.getAddress(), await baseToken.getAddress()];
      const balBeforeB = await baseToken.balanceOf(user1.address);
      await bofh.connect(user1).executeSwap(pathB, [30, 30], amountIn, 1n, deadline);
      const balAfterB = await baseToken.balanceOf(user1.address);
      const outputAt030 = balAfterB - balBeforeB + amountIn;

      // Lower fee -> strictly more output for identical reserves/amount.
      expect(outputAt025).to.be.greaterThan(outputAt030);
    });
  });
});
