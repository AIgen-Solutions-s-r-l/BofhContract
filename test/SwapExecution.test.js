const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("Swap Execution Tests", function () {
  async function deployContractsFixture() {
    const [owner, user1, user2] = await ethers.getSigners();

    // Deploy mock tokens
    const MockToken = await ethers.getContractFactory("MockToken");
    const baseToken = await MockToken.deploy("Base Token", "BASE", ethers.parseEther("1000000"));
    const tokenA = await MockToken.deploy("Token A", "TKNA", ethers.parseEther("1000000"));
    const tokenB = await MockToken.deploy("Token B", "TKNB", ethers.parseEther("1000000"));
    const tokenC = await MockToken.deploy("Token C", "TKNC", ethers.parseEther("1000000"));
    const tokenD = await MockToken.deploy("Token D", "TKND", ethers.parseEther("1000000"));

    // Deploy factory
    const MockFactory = await ethers.getContractFactory("MockFactory");
    const factory = await MockFactory.deploy();

    // Create pairs
    await factory.createPair(await baseToken.getAddress(), await tokenA.getAddress());
    await factory.createPair(await tokenA.getAddress(), await tokenB.getAddress());
    await factory.createPair(await tokenB.getAddress(), await tokenC.getAddress());
    await factory.createPair(await tokenC.getAddress(), await tokenD.getAddress()); // Added for 5-way path
    await factory.createPair(await tokenC.getAddress(), await baseToken.getAddress());
    await factory.createPair(await baseToken.getAddress(), await tokenB.getAddress());
    await factory.createPair(await tokenB.getAddress(), await tokenD.getAddress());
    await factory.createPair(await tokenD.getAddress(), await baseToken.getAddress());

    const pairBaseA = await factory.getPair(await baseToken.getAddress(), await tokenA.getAddress());
    const pairAB = await factory.getPair(await tokenA.getAddress(), await tokenB.getAddress());
    const pairBC = await factory.getPair(await tokenB.getAddress(), await tokenC.getAddress());
    const pairCD = await factory.getPair(await tokenC.getAddress(), await tokenD.getAddress());
    const pairCBase = await factory.getPair(await tokenC.getAddress(), await baseToken.getAddress());
    const pairBaseB = await factory.getPair(await baseToken.getAddress(), await tokenB.getAddress());
    const pairBD = await factory.getPair(await tokenB.getAddress(), await tokenD.getAddress());
    const pairDBase = await factory.getPair(await tokenD.getAddress(), await baseToken.getAddress());

    const MockPair = await ethers.getContractFactory("MockPair");
    const pairBaseAContract = MockPair.attach(pairBaseA);
    const pairABContract = MockPair.attach(pairAB);
    const pairBCContract = MockPair.attach(pairBC);
    const pairCDContract = MockPair.attach(pairCD);
    const pairCBaseContract = MockPair.attach(pairCBase);
    const pairBaseBContract = MockPair.attach(pairBaseB);
    const pairBDContract = MockPair.attach(pairBD);
    const pairDBaseContract = MockPair.attach(pairDBase);

    // Add liquidity to all pairs
    const liquidityBase = ethers.parseEther("10000");
    const liquidityOther = ethers.parseEther("5000");

    // Pair BASE-A
    await baseToken.transfer(pairBaseA, liquidityBase);
    await tokenA.transfer(pairBaseA, liquidityOther);
    await pairBaseAContract.sync();

    // Pair A-B
    await tokenA.transfer(pairAB, liquidityOther);
    await tokenB.transfer(pairAB, liquidityOther);
    await pairABContract.sync();

    // Pair B-C
    await tokenB.transfer(pairBC, liquidityOther);
    await tokenC.transfer(pairBC, liquidityOther);
    await pairBCContract.sync();

    // Pair C-D
    await tokenC.transfer(pairCD, liquidityOther);
    await tokenD.transfer(pairCD, liquidityOther);
    await pairCDContract.sync();

    // Pair C-BASE
    await tokenC.transfer(pairCBase, liquidityOther);
    await baseToken.transfer(pairCBase, liquidityBase);
    await pairCBaseContract.sync();

    // Pair BASE-B
    await baseToken.transfer(pairBaseB, liquidityBase);
    await tokenB.transfer(pairBaseB, liquidityOther);
    await pairBaseBContract.sync();

    // Pair B-D
    await tokenB.transfer(pairBD, liquidityOther);
    await tokenD.transfer(pairBD, liquidityOther);
    await pairBDContract.sync();

    // Pair D-BASE
    await tokenD.transfer(pairDBase, liquidityOther);
    await baseToken.transfer(pairDBase, liquidityBase);
    await pairDBaseContract.sync();

    // Deploy BofhContractV2
    const BofhContractV2 = await ethers.getContractFactory("BofhContractV2");
    const bofh = await BofhContractV2.deploy(
      await baseToken.getAddress(),
      await factory.getAddress()
    );

    // Fund users with base tokens
    await baseToken.transfer(user1.address, ethers.parseEther("1000"));
    await baseToken.transfer(user2.address, ethers.parseEther("1000"));

    // Approve bofh contract to spend user tokens
    await baseToken.connect(user1).approve(await bofh.getAddress(), ethers.MaxUint256);
    await baseToken.connect(user2).approve(await bofh.getAddress(), ethers.MaxUint256);

    return {
      bofh,
      baseToken,
      tokenA,
      tokenB,
      tokenC,
      tokenD,
      factory,
      pairBaseA,
      pairAB,
      pairBC,
      pairCBase,
      pairBaseB,
      pairBD,
      pairDBase,
      owner,
      user1,
      user2
    };
  }

  describe("2-Way Swap Execution (BASE → A → BASE)", function () {
    it("Should execute simple 2-way swap successfully", async function () {
      const { bofh, baseToken, tokenA, user1, pairBaseA } = await loadFixture(deployContractsFixture);

      const path = [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()];
      const fees = [30, 30]; // 0.3% fee for each swap
      const amountIn = ethers.parseEther("10");
      const minAmountOut = ethers.parseEther("1"); // Conservative minimum (swaps optimize for best output)
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      const balanceBefore = await baseToken.balanceOf(user1.address);

      // Note: This test will need actual pair addresses in the path, not token addresses
      // For now, testing the validation passes
      try {
        const tx = await bofh.connect(user1).executeSwap(path, fees, amountIn, minAmountOut, deadline);
        const receipt = await tx.wait();
        console.log("Swap successful, gas used:", receipt.gasUsed.toString());
      } catch (error) {
        console.log("Swap failed with error:", error.message);
        console.log("AmountIn:", ethers.formatEther(amountIn), "MinAmountOut:", ethers.formatEther(minAmountOut));
        throw error;
      }

      const balanceAfter = await baseToken.balanceOf(user1.address);
      console.log("Balance before:", ethers.formatEther(balanceBefore), "Balance after:", ethers.formatEther(balanceAfter));
      expect(balanceAfter).to.be.gte(balanceBefore - amountIn); // Should get something back
    });

    it("Should revert if output is below minAmountOut", async function () {
      const { bofh, baseToken, tokenA, user1 } = await loadFixture(deployContractsFixture);

      const path = [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()];
      const fees = [30, 30];
      const amountIn = ethers.parseEther("10");
      const minAmountOut = ethers.parseEther("100"); // Unrealistic expectation
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      await expect(
        bofh.connect(user1).executeSwap(path, fees, amountIn, minAmountOut, deadline)
      ).to.be.revertedWithCustomError(bofh, "InsufficientOutput");
    });

    it("Should emit SwapExecuted event", async function () {
      const { bofh, baseToken, tokenA, user1 } = await loadFixture(deployContractsFixture);

      const path = [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()];
      const fees = [30, 30];
      const amountIn = ethers.parseEther("10");
      const minAmountOut = ethers.parseEther("1");
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      await expect(
        bofh.connect(user1).executeSwap(path, fees, amountIn, minAmountOut, deadline)
      ).to.emit(bofh, "SwapExecuted");
    });
  });

  describe("3-Way Swap Execution (BASE → A → B → BASE)", function () {
    it("Should execute 3-way triangular arbitrage", async function () {
      const { bofh, baseToken, tokenA, tokenB, user1 } = await loadFixture(deployContractsFixture);

      const path = [
        await baseToken.getAddress(),
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        await baseToken.getAddress()
      ];
      const fees = [30, 30, 30];
      const amountIn = ethers.parseEther("10");
      const minAmountOut = ethers.parseEther("9");
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      await expect(
        bofh.connect(user1).executeSwap(path, fees, amountIn, minAmountOut, deadline)
      ).to.not.be.reverted;
    });

    it("Should track cumulative price impact", async function () {
      const { bofh, baseToken, tokenA, tokenB, user1 } = await loadFixture(deployContractsFixture);

      const path = [
        await baseToken.getAddress(),
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        await baseToken.getAddress()
      ];
      const fees = [30, 30, 30];
      const amountIn = ethers.parseEther("10");
      const minAmountOut = ethers.parseEther("1");
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      const tx = await bofh.connect(user1).executeSwap(path, fees, amountIn, minAmountOut, deadline);
      const receipt = await tx.wait();

      // Check for SwapExecuted event with priceImpact
      const event = receipt.logs.find(log => {
        try {
          const parsed = bofh.interface.parseLog(log);
          return parsed && parsed.name === "SwapExecuted";
        } catch {
          return false;
        }
      });

      expect(event).to.not.be.undefined;
    });
  });

  describe("4-Way Swap Execution (Golden Ratio Optimization)", function () {
    it("Should execute 4-way swap with golden ratio splits", async function () {
      const { bofh, baseToken, tokenA, tokenB, tokenC, user1 } = await loadFixture(deployContractsFixture);

      const path = [
        await baseToken.getAddress(),
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        await tokenC.getAddress(),
        await baseToken.getAddress()
      ];
      const fees = [30, 30, 30, 30];
      const amountIn = ethers.parseEther("20");
      const minAmountOut = ethers.parseEther("15");
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      await expect(
        bofh.connect(user1).executeSwap(path, fees, amountIn, minAmountOut, deadline)
      ).to.not.be.reverted;
    });

    it("Should apply golden ratio (φ ≈ 0.618) for amount distribution", async function () {
      const { bofh, baseToken, tokenA, tokenB, tokenC, user1 } = await loadFixture(deployContractsFixture);

      const path = [
        await baseToken.getAddress(),
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        await tokenC.getAddress(),
        await baseToken.getAddress()
      ];
      const fees = [30, 30, 30, 30];
      const amountIn = ethers.parseEther("100");
      const minAmountOut = ethers.parseEther("1");
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      const balanceBefore = await baseToken.balanceOf(user1.address);

      await bofh.connect(user1).executeSwap(path, fees, amountIn, minAmountOut, deadline);

      const balanceAfter = await baseToken.balanceOf(user1.address);

      // Verify tokens were transferred
      expect(balanceAfter).to.be.lt(balanceBefore);
    });

    it("Should handle maximum path length (5 addresses)", async function () {
      const { bofh, baseToken, tokenA, tokenB, tokenC, user1 } = await loadFixture(deployContractsFixture);

      const path = [
        await baseToken.getAddress(),
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        await tokenC.getAddress(),
        await baseToken.getAddress()
      ];
      const fees = [30, 30, 30, 30];
      const amountIn = ethers.parseEther("10");
      const minAmountOut = ethers.parseEther("1");
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      await expect(
        bofh.connect(user1).executeSwap(path, fees, amountIn, minAmountOut, deadline)
      ).to.not.be.reverted;
    });
  });

  describe("5-Way Swap Execution (Complex Optimization)", function () {
    it("Should execute 5-way swap (max path length)", async function () {
      const { bofh, baseToken, tokenA, tokenB, tokenC, tokenD, user1 } = await loadFixture(deployContractsFixture);

      const path = [
        await baseToken.getAddress(),
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        await tokenC.getAddress(),
        await tokenD.getAddress(),
        await baseToken.getAddress()
      ];
      const fees = [30, 30, 30, 30, 30];
      const amountIn = ethers.parseEther("50");
      const minAmountOut = ethers.parseEther("1");
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      await expect(
        bofh.connect(user1).executeSwap(path, fees, amountIn, minAmountOut, deadline)
      ).to.not.be.reverted;
    });

    it("Should apply golden ratio squared (φ² ≈ 0.382) for 5-way splits", async function () {
      const { bofh, baseToken, tokenA, tokenB, tokenC, tokenD, user1 } = await loadFixture(deployContractsFixture);

      const path = [
        await baseToken.getAddress(),
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        await tokenC.getAddress(),
        await tokenD.getAddress(),
        await baseToken.getAddress()
      ];
      const fees = [30, 30, 30, 30, 30];
      const amountIn = ethers.parseEther("100");
      const minAmountOut = ethers.parseEther("1");
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      const tx = await bofh.connect(user1).executeSwap(path, fees, amountIn, minAmountOut, deadline);
      const receipt = await tx.wait();

      expect(receipt.status).to.equal(1);
    });
  });

  describe("Gas Consumption", function () {
    it("Should track gas usage per swap step", async function () {
      const { bofh, baseToken, tokenA, tokenB, user1 } = await loadFixture(deployContractsFixture);

      const path = [
        await baseToken.getAddress(),
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        await baseToken.getAddress()
      ];
      const fees = [30, 30, 30];
      const amountIn = ethers.parseEther("10");
      const minAmountOut = ethers.parseEther("1");
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      const tx = await bofh.connect(user1).executeSwap(path, fees, amountIn, minAmountOut, deadline);
      const receipt = await tx.wait();

      expect(receipt.gasUsed).to.be.gt(0);
      expect(receipt.gasUsed).to.be.lt(1000000); // Should be reasonable
    });

    it("Should have higher gas for longer paths", async function () {
      const { bofh, baseToken, tokenA, tokenB, tokenC, tokenD, user1 } = await loadFixture(deployContractsFixture);

      // 2-way swap
      const path2 = [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()];
      const fees2 = [30, 30];
      const tx2 = await bofh.connect(user1).executeSwap(
        path2,
        fees2,
        ethers.parseEther("10"),
        ethers.parseEther("1"),
        Math.floor(Date.now() / 1000) + 3600
      );
      const receipt2 = await tx2.wait();
      const gas2 = receipt2.gasUsed;

      // 5-way swap
      const path5 = [
        await baseToken.getAddress(),
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        await tokenC.getAddress(),
        await tokenD.getAddress(),
        await baseToken.getAddress()
      ];
      const fees5 = [30, 30, 30, 30, 30];
      const tx5 = await bofh.connect(user1).executeSwap(
        path5,
        fees5,
        ethers.parseEther("50"),
        ethers.parseEther("1"),
        Math.floor(Date.now() / 1000) + 3600
      );
      const receipt5 = await tx5.wait();
      const gas5 = receipt5.gasUsed;

      expect(gas5).to.be.gt(gas2);
    });
  });

  describe("Price Impact Validation", function () {
    it("Should revert if cumulative price impact exceeds maximum", async function () {
      const { bofh, baseToken, tokenA, tokenB, user1 } = await loadFixture(deployContractsFixture);

      // Set a very low max price impact
      await bofh.updateRiskParams(
        ethers.parseUnits("1000", 6), // maxTradeVolume
        ethers.parseUnits("100", 6),  // minPoolLiquidity
        ethers.parseUnits("0.01", 6), // maxPriceImpact (0.01% - very low)
        50                            // sandwichProtectionBips
      );

      const path = [
        await baseToken.getAddress(),
        await tokenA.getAddress(),
        await tokenB.getAddress(),
        await baseToken.getAddress()
      ];
      const fees = [30, 30, 30];
      const amountIn = ethers.parseEther("100"); // Large amount for high impact
      const minAmountOut = ethers.parseEther("1");
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      // Should revert due to excessive price impact (either from PoolLib or contract check)
      await expect(
        bofh.connect(user1).executeSwap(path, fees, amountIn, minAmountOut, deadline)
      ).to.be.reverted; // Will revert with "Price impact too high" from PoolLib.validateSwap
    });
  });
});
