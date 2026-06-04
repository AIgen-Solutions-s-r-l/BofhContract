const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("MEV Protection Tests", function () {
  async function deployContractsFixture() {
    const [owner, user1] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockToken");
    const baseToken = await MockToken.deploy("Base Token", "BASE", ethers.parseEther("1000000"));
    const tokenA = await MockToken.deploy("Token A", "TKNA", ethers.parseEther("1000000"));

    const MockFactory = await ethers.getContractFactory("MockFactory");
    const factory = await MockFactory.deploy();

    await factory.createPair(await baseToken.getAddress(), await tokenA.getAddress());
    const pairBaseA = await factory.getPair(await baseToken.getAddress(), await tokenA.getAddress());

    const MockPair = await ethers.getContractFactory("MockPair");
    const pairBaseAContract = MockPair.attach(pairBaseA);

    await baseToken.transfer(pairBaseA, ethers.parseEther("10000"));
    await tokenA.transfer(pairBaseA, ethers.parseEther("5000"));
    await pairBaseAContract.sync();

    const BofhContractV2 = await ethers.getContractFactory("BofhContractV2");
    const bofh = await BofhContractV2.deploy(
      await baseToken.getAddress(),
      await factory.getAddress()
    );

    await baseToken.transfer(user1.address, ethers.parseEther("1000"));
    await baseToken.connect(user1).approve(await bofh.getAddress(), ethers.MaxUint256);

    return {
      bofh,
      baseToken,
      tokenA,
      owner,
      user1,
      pairBaseA
    };
  }

  describe("configureMEVProtection", function () {
    it("Should configure MEV protection with valid parameters", async function () {
      const { bofh, owner } = await loadFixture(deployContractsFixture);

      await bofh.connect(owner).configureMEVProtection(true, 5, 10);

      const [enabled, maxTx, minDelay] = await bofh.getMEVProtectionConfig();
      expect(enabled).to.be.true;
      expect(maxTx).to.equal(5);
      expect(minDelay).to.equal(10);
    });

    it("Should emit MEVProtectionUpdated event", async function () {
      const { bofh, owner } = await loadFixture(deployContractsFixture);

      await expect(bofh.connect(owner).configureMEVProtection(true, 3, 5))
        .to.emit(bofh, "MEVProtectionUpdated")
        .withArgs(true, 3, 5);
    });

    it("Should allow disabling MEV protection", async function () {
      const { bofh, owner } = await loadFixture(deployContractsFixture);

      await bofh.connect(owner).configureMEVProtection(true, 5, 10);
      await bofh.connect(owner).configureMEVProtection(false, 1, 1);

      const [enabled, maxTx, minDelay] = await bofh.getMEVProtectionConfig();
      expect(enabled).to.be.false;
    });

    it("Should reject zero maxTxPerBlock", async function () {
      const { bofh, owner } = await loadFixture(deployContractsFixture);

      await expect(
        bofh.connect(owner).configureMEVProtection(true, 0, 10)
      ).to.be.revertedWith("Invalid max tx per block");
    });

    it("Should reject zero minTxDelay", async function () {
      const { bofh, owner } = await loadFixture(deployContractsFixture);

      await expect(
        bofh.connect(owner).configureMEVProtection(true, 5, 0)
      ).to.be.revertedWith("Invalid min tx delay");
    });

    it("Should prevent non-owner from configuring MEV protection", async function () {
      const { bofh, user1 } = await loadFixture(deployContractsFixture);

      await expect(
        bofh.connect(user1).configureMEVProtection(true, 5, 10)
      ).to.be.reverted;
    });
  });

  describe("getMEVProtectionConfig", function () {
    it("Should return default MEV protection config", async function () {
      const { bofh } = await loadFixture(deployContractsFixture);

      const [enabled, maxTx, minDelay] = await bofh.getMEVProtectionConfig();

      // Default values (MEV protection disabled by default, but limits are initialized)
      expect(enabled).to.be.false;
      expect(maxTx).to.equal(3); // Default from contract
      expect(minDelay).to.equal(12); // Default from contract
    });

    it("Should return updated MEV protection config", async function () {
      const { bofh, owner } = await loadFixture(deployContractsFixture);

      await bofh.connect(owner).configureMEVProtection(true, 10, 20);

      const [enabled, maxTx, minDelay] = await bofh.getMEVProtectionConfig();
      expect(enabled).to.be.true;
      expect(maxTx).to.equal(10);
      expect(minDelay).to.equal(20);
    });
  });

  describe("antiMEV modifier - Rate Limiting", function () {
    it("Should allow swap when MEV protection is disabled", async function () {
      const { bofh, baseToken, tokenA, user1 } = await loadFixture(deployContractsFixture);

      // MEV protection disabled by default
      const path = [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()];
      const fees = [30, 30];
      const amountIn = ethers.parseEther("10");
      const minAmountOut = ethers.parseEther("1");
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      // Should succeed
      await expect(
        bofh.connect(user1).executeSwap(path, fees, amountIn, minAmountOut, deadline)
      ).to.not.be.reverted;
    });

    it("Should enforce minimum transaction delay when enabled", async function () {
      const { bofh, baseToken, tokenA, owner, user1 } = await loadFixture(deployContractsFixture);

      // Enable MEV protection with 60 second delay
      await bofh.connect(owner).configureMEVProtection(true, 10, 60);

      const path = [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()];
      const fees = [30, 30];
      const amountIn = ethers.parseEther("1");
      const minAmountOut = ethers.parseEther("0.1");
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      // First transaction should succeed
      await bofh.connect(user1).executeSwap(path, fees, amountIn, minAmountOut, deadline);

      // Second transaction immediately after should fail
      await expect(
        bofh.connect(user1).executeSwap(path, fees, amountIn, minAmountOut, deadline)
      ).to.be.revertedWithCustomError(bofh, "RateLimitExceeded");
    });

    it("Should allow transaction after delay period", async function () {
      const { bofh, baseToken, tokenA, owner, user1 } = await loadFixture(deployContractsFixture);

      // Enable MEV protection with 5 second delay
      await bofh.connect(owner).configureMEVProtection(true, 10, 5);

      const path = [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()];
      const fees = [30, 30];
      const amountIn = ethers.parseEther("1");
      const minAmountOut = ethers.parseEther("0.1");
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      // First transaction
      await bofh.connect(user1).executeSwap(path, fees, amountIn, minAmountOut, deadline);

      // Wait for delay period
      await time.increase(6);

      // Second transaction should succeed after delay
      await expect(
        bofh.connect(user1).executeSwap(path, fees, amountIn, minAmountOut, deadline)
      ).to.not.be.reverted;
    });

    it("Should allow multiple transactions when MEV protection disabled", async function () {
      const { bofh, baseToken, tokenA, user1 } = await loadFixture(deployContractsFixture);

      // MEV protection disabled by default
      const path = [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()];
      const fees = [30, 30];
      const amountIn = ethers.parseEther("0.5");
      const minAmountOut = ethers.parseEther("0.1");
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      // Multiple rapid transactions should succeed when protection is off
      await bofh.connect(user1).executeSwap(path, fees, amountIn, minAmountOut, deadline);
      await bofh.connect(user1).executeSwap(path, fees, amountIn, minAmountOut, deadline);
      await bofh.connect(user1).executeSwap(path, fees, amountIn, minAmountOut, deadline);

      // All should succeed
      expect(true).to.be.true;
    });
  });

  describe("MEV Protection Integration", function () {
    it("Should work with paused state", async function () {
      const { bofh, baseToken, tokenA, owner, user1 } = await loadFixture(deployContractsFixture);

      await bofh.connect(owner).configureMEVProtection(true, 10, 5);
      await bofh.connect(owner).emergencyPause();

      const path = [await baseToken.getAddress(), await tokenA.getAddress(), await baseToken.getAddress()];
      const fees = [30, 30];
      const amountIn = ethers.parseEther("1");
      const minAmountOut = ethers.parseEther("0.1");
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      // Should fail due to pause, not MEV protection
      await expect(
        bofh.connect(user1).executeSwap(path, fees, amountIn, minAmountOut, deadline)
      ).to.be.reverted;
    });
  });
});
