const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Read-only reentrancy guard on the fee-aware views (review Fix D).
 *
 * SecurityLib.checkNotLocked is invoked at the top of getOptimalPathMetricsWithFees /
 * getOptimalPathMetricsMultiDex / getOptimalPathMetrics. This proves the guard FIRES: a token on
 * the swap path re-enters a fee-aware view (via STATICCALL) while the swap's nonReentrant lock is
 * held; the view reverts ContractLocked(), which the token records. STATICCALL keeps the probe
 * side-effect-free so the swap itself still completes.
 */
describe("Read-only reentrancy guard (fee-aware views)", function () {
  async function deployFixture() {
    const [owner, user1] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockToken");
    const baseToken = await MockToken.deploy("Base Token", "BASE", ethers.parseEther("100000000"));

    // tokenA re-enters a view on every transfer once armed.
    const MockReentrantToken = await ethers.getContractFactory("MockReentrantToken");
    const tokenA = await MockReentrantToken.deploy("Reentrant A", "RA", ethers.parseEther("100000000"));

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
    await tokenA.transfer(pairAddr, liquidity); // not armed yet -> no reentry during setup
    await pair.sync();

    const BofhContractV2 = await ethers.getContractFactory("BofhContractV2");
    const bofh = await BofhContractV2.deploy(baseAddr, await factory.getAddress());

    await baseToken.transfer(user1.address, ethers.parseEther("100000"));
    await baseToken.connect(user1).approve(await bofh.getAddress(), ethers.MaxUint256);

    return { owner, user1, bofh, baseToken, tokenA, factory, pair, baseAddr, aAddr, liquidity };
  }

  it("a fee-aware view re-entered mid-swap reverts ContractLocked (and the swap still completes)", async function () {
    const { bofh, user1, tokenA, baseAddr, aAddr } = await loadFixture(deployFixture);

    // Arm tokenA to STATICCALL a guarded view on every transfer. The guard runs before any arg
    // validation, so empty arrays are fine: while locked it reverts ContractLocked regardless.
    const probe = bofh.interface.encodeFunctionData("getOptimalPathMetricsWithFees", [[], [], []]);
    await tokenA.arm(await bofh.getAddress(), probe);

    expect(await tokenA.sawContractLocked()).to.equal(false);

    const path = [baseAddr, aAddr, baseAddr];
    const fees = [30, 30];
    const amountIn = ethers.parseEther("100");
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;

    // The swap triggers tokenA transfers while the nonReentrant lock is held.
    await expect(
      bofh.connect(user1).executeSwap(path, fees, amountIn, 1n, deadline)
    ).to.not.be.reverted;

    // Proof the guard fired during the locked swap.
    expect(await tokenA.sawContractLocked()).to.equal(true);
  });

  it("the fee-aware view is callable normally when no swap is in progress (guard is a no-op when unlocked)", async function () {
    const { bofh, baseAddr, aAddr } = await loadFixture(deployFixture);

    const path = [baseAddr, aAddr];
    const [expectedOutput] = await bofh.getOptimalPathMetricsWithFees(path, [ethers.parseEther("100")], [30]);
    expect(expectedOutput).to.be.gt(0);
  });
});
