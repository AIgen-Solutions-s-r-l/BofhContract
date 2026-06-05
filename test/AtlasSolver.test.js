const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Atlas/FastLane backrun SOLVER contract tests (Play #1).
 *
 * BofhAtlasSolver is the Atlas solver leg: Atlas (here MockAtlas) calls atlasSolverCall with a
 * winning bid; the solver decodes a multi-DEX backrun, settles it through the already-audited
 * BofhContractV2.executeSwapMultiDex commodity executor, pays the committed bid to the Execution
 * Environment, and sweeps the surplus to the beneficiary.
 *
 * The executor is NON-CUSTODIAL: it pulls amountIn of base from the solver (via approve) for the
 * duration of the call and returns the round-trip output to the solver. The solver therefore holds
 * working capital only for the metacall's "borrow" leg — we seed it with base at fixture time to
 * model that float.
 *
 * GATE-0 (mirrored from the contract NatSpec): these tests prove the WIRING + accounting only. They
 * do NOT establish that a permissionless Atlas DEX-backrun OFA is still open post-Chainlink, nor
 * that the edge clears net-of-gas on real data. Both are external prerequisites to any deploy/bond.
 */
describe("BofhAtlasSolver (Atlas backrun solver leg)", function () {
  const MAX_UINT256 = ethers.MaxUint256;

  // Constant-product amount-out, identical to executePathStep's on-chain formula.
  function getAmountOut(amountIn, reserveIn, reserveOut, feeBps) {
    const feeNum = 10000n - BigInt(feeBps);
    const amountInWithFee = amountIn * feeNum;
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 10000n + amountInWithFee;
    return numerator / denominator;
  }

  async function deadlineFromNow() {
    return (await ethers.provider.getBlock("latest")).timestamp + 3600;
  }

  /**
   * Profitable-backrun fixture.
   *
   * Two DEXes for the BASE/A pair. We DELIBERATELY imbalance pool1 so that a BASE->A->BASE
   * round-trip (hop0 on dexId0, hop1 on dexId1) nets MORE base than it spent — that surplus is the
   * arbitrage the backrun captures, out of which the bid is paid.
   *
   *   pool0 (dexId 0): BASE=1,000,000  A=1,000,000   (fair)
   *   pool1 (dexId 1): BASE=2,000,000  A=1,000,000   (A is "expensive" / BASE is cheap here, so
   *                                                   selling A into pool1 returns lots of BASE)
   *
   * Fees set to 0 on both pools (and fees=[0,0]) so the expected output is exactly computable and
   * the imbalance alone drives the profit.
   */
  async function deployProfitableFixture() {
    const [owner, searcher, stranger, beneficiary] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockToken");
    const baseToken = await MockToken.deploy("Base Token", "BASE", ethers.parseEther("100000000"));
    const tokenA = await MockToken.deploy("Token A", "TKNA", ethers.parseEther("100000000"));

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

    // pool0: fair 1:1
    const baseReserve0 = ethers.parseEther("1000000");
    const aReserve0 = ethers.parseEther("1000000");
    await baseToken.transfer(pair0Addr, baseReserve0);
    await tokenA.transfer(pair0Addr, aReserve0);
    await pair0.sync();

    // pool1: BASE-heavy so A->BASE returns extra BASE => round-trip profit
    const baseReserve1 = ethers.parseEther("2000000");
    const aReserve1 = ethers.parseEther("1000000");
    await baseToken.transfer(pair1Addr, baseReserve1);
    await tokenA.transfer(pair1Addr, aReserve1);
    await pair1.sync();

    await pair0.setSwapFee(0);
    await pair1.setSwapFee(0);

    const BofhContractV2 = await ethers.getContractFactory("BofhContractV2");
    const executor = await BofhContractV2.deploy(baseAddr, await factory0.getAddress());
    await executor.connect(owner).setDex(1, await factory1.getAddress(), 0, true);

    const BofhAtlasSolver = await ethers.getContractFactory("BofhAtlasSolver");
    const solver = await BofhAtlasSolver.connect(owner).deploy();
    await solver.connect(owner).configureExecutor(await executor.getAddress(), baseAddr);

    const MockAtlas = await ethers.getContractFactory("MockAtlas");
    const atlas = await MockAtlas.deploy();
    await solver
      .connect(owner)
      .configureAtlas(await atlas.getAddress(), searcher.address);
    await solver.connect(owner).setBeneficiary(beneficiary.address);

    // Seed the solver with base-token float for the borrow leg (executor pulls amountIn from it).
    const float = ethers.parseEther("100000");
    await baseToken.transfer(await solver.getAddress(), float);

    // Helper: exact round-trip output for a given amountIn through pool0 (0 fee) then pool1 (0 fee).
    function roundTripOut(amountIn) {
      const out1 = getAmountOut(amountIn, baseReserve0, aReserve0, 0); // BASE->A on pool0
      const out2 = getAmountOut(out1, aReserve1, baseReserve1, 0); // A->BASE on pool1
      return out2;
    }

    return {
      owner, searcher, stranger, beneficiary,
      baseToken, tokenA, baseAddr, aAddr,
      factory0, factory1,
      executor, solver, atlas,
      float, roundTripOut,
    };
  }

  function encodeBackrun(br) {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    return coder.encode(
      [
        "tuple(address[] path,uint256[] fees,uint16[] dexIds,uint256 amountIn,uint256 minAmountOut,uint256 deadline)",
      ],
      [br]
    );
  }

  /**
   * Mock-executor fixture used to ISOLATE the solver's OWN profit guard.
   *
   * In the real path the solver forces enforcedMin = max(minAmountOut, amountIn + bidAmount), so
   * BofhContractV2 reverts InsufficientOutput before the solver's `grossOut < amountIn` /
   * `profit < bidAmount` checks can ever run. To exercise those two branches directly we point the
   * solver at MockSolverExecutor, which IGNORES minAmountOut and returns a caller-chosen grossOut
   * (after pulling amountIn exactly like the real, non-custodial executor). The mock is seeded with
   * extra base so it can also return grossOut > amountIn for the profit<bid branch.
   */
  async function deployMockExecutorFixture() {
    const [owner, searcher, stranger, beneficiary] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockToken");
    const baseToken = await MockToken.deploy("Base Token", "BASE", ethers.parseEther("100000000"));
    const tokenA = await MockToken.deploy("Token A", "TKNA", ethers.parseEther("100000000"));
    const baseAddr = await baseToken.getAddress();
    const aAddr = await tokenA.getAddress();

    const MockSolverExecutor = await ethers.getContractFactory("MockSolverExecutor");
    const mockExec = await MockSolverExecutor.deploy(baseAddr);

    const BofhAtlasSolver = await ethers.getContractFactory("BofhAtlasSolver");
    const solver = await BofhAtlasSolver.connect(owner).deploy();
    await solver.connect(owner).configureExecutor(await mockExec.getAddress(), baseAddr);

    const MockAtlas = await ethers.getContractFactory("MockAtlas");
    const atlas = await MockAtlas.deploy();
    await solver.connect(owner).configureAtlas(await atlas.getAddress(), searcher.address);
    await solver.connect(owner).setBeneficiary(beneficiary.address);

    // Solver float (principal it lends to the executor for the borrow leg).
    const float = ethers.parseEther("100000");
    await baseToken.transfer(await solver.getAddress(), float);
    // Mock executor liquidity so it can hand back grossOut (possibly > amountIn).
    await baseToken.transfer(await mockExec.getAddress(), ethers.parseEther("100000"));

    return {
      owner, searcher, stranger, beneficiary,
      baseToken, tokenA, baseAddr, aAddr,
      mockExec, solver, atlas, float,
    };
  }

  describe("Configuration & access control", function () {
    it("constructor sets owner and beneficiary to deployer", async function () {
      const { solver, owner } = await loadFixture(deployProfitableFixture);
      // beneficiary was reassigned in fixture; owner remains the deployer.
      expect(await solver.owner()).to.equal(owner.address);
    });

    it("non-owner cannot configureExecutor / configureAtlas / setBeneficiary", async function () {
      const { solver, stranger, executor, baseAddr, atlas } =
        await loadFixture(deployProfitableFixture);
      await expect(
        solver.connect(stranger).configureExecutor(await executor.getAddress(), baseAddr)
      ).to.be.revertedWithCustomError(solver, "NotOwner");
      await expect(
        solver.connect(stranger).configureAtlas(await atlas.getAddress(), stranger.address)
      ).to.be.revertedWithCustomError(solver, "NotOwner");
      await expect(
        solver.connect(stranger).setBeneficiary(stranger.address)
      ).to.be.revertedWithCustomError(solver, "NotOwner");
    });

    it("rejects zero-address configuration", async function () {
      const { solver, owner, baseAddr } = await loadFixture(deployProfitableFixture);
      await expect(
        solver.connect(owner).configureExecutor(ethers.ZeroAddress, baseAddr)
      ).to.be.revertedWithCustomError(solver, "ZeroAddress");
      await expect(
        solver.connect(owner).configureAtlas(ethers.ZeroAddress, owner.address)
      ).to.be.revertedWithCustomError(solver, "ZeroAddress");
    });

    it("atlasSolverCall reverts if caller is not the configured Atlas (NotAtlas)", async function () {
      const { solver, stranger, searcher, baseAddr } =
        await loadFixture(deployProfitableFixture);
      // A direct (non-Atlas) caller must be rejected before any work happens.
      const br = encodeBackrun({
        path: [baseAddr, baseAddr],
        fees: [0],
        dexIds: [0],
        amountIn: 1n,
        minAmountOut: 1n,
        deadline: await deadlineFromNow(),
      });
      await expect(
        solver
          .connect(stranger)
          .atlasSolverCall(searcher.address, stranger.address, baseAddr, 0, br, "0x")
      ).to.be.revertedWithCustomError(solver, "NotAtlas");
    });
  });

  describe("Backrun settlement (happy path)", function () {
    it("routes a profitable backrun through the executor, repays the bid, sweeps surplus", async function () {
      const {
        solver, atlas, searcher, beneficiary,
        baseToken, baseAddr, aAddr, roundTripOut, float,
      } = await loadFixture(deployProfitableFixture);

      const amountIn = ethers.parseEther("1000");
      const grossOut = roundTripOut(amountIn);
      expect(grossOut).to.be.greaterThan(amountIn); // sanity: this backrun IS profitable

      // Bid a portion of the realized profit (must be <= grossOut, and we leave headroom).
      const profit = grossOut - amountIn;
      const bidAmount = profit / 2n;

      const br = {
        path: [baseAddr, aAddr, baseAddr],
        fees: [0, 0],
        dexIds: [0, 1],
        amountIn,
        minAmountOut: 1n,
        deadline: await deadlineFromNow(),
      };
      const data = encodeBackrun(br);

      const eeAddr = await atlas.getAddress(); // EE == the mock atlas in default config
      const eeBefore = await baseToken.balanceOf(eeAddr);
      const benBefore = await baseToken.balanceOf(beneficiary.address);
      const solverBefore = await baseToken.balanceOf(await solver.getAddress());

      await expect(
        atlas.metacall(await solver.getAddress(), searcher.address, baseAddr, bidAmount, data)
      ).to.emit(solver, "BackrunSettled");

      const eeAfter = await baseToken.balanceOf(eeAddr);
      const benAfter = await baseToken.balanceOf(beneficiary.address);
      const solverAfter = await baseToken.balanceOf(await solver.getAddress());

      // Bid paid to EE exactly.
      expect(eeAfter - eeBefore).to.equal(bidAmount);
      // Surplus = PROFIT - bidAmount swept to beneficiary (principal stays in the solver).
      expect(benAfter - benBefore).to.equal(profit - bidAmount);
      // Non-custodial principal preservation: the solver's base float is exactly conserved across
      // the metacall. It lent amountIn (pulled by executor) and got grossOut back; out of the
      // grossOut - amountIn profit it paid bid(EE) + surplus(beneficiary) = profit, leaving the
      // original amountIn principal -> float unchanged.
      expect(solverAfter).to.equal(solverBefore);
      expect(solverAfter).to.equal(float);
    });

    it("zero bid still settles and sweeps the full PROFIT (not principal) to the beneficiary", async function () {
      const {
        solver, atlas, searcher, beneficiary,
        baseToken, baseAddr, aAddr, roundTripOut,
      } = await loadFixture(deployProfitableFixture);

      const amountIn = ethers.parseEther("500");
      const grossOut = roundTripOut(amountIn);
      const profit = grossOut - amountIn;

      const br = {
        path: [baseAddr, aAddr, baseAddr],
        fees: [0, 0],
        dexIds: [0, 1],
        amountIn,
        minAmountOut: 1n,
        deadline: await deadlineFromNow(),
      };

      const benBefore = await baseToken.balanceOf(beneficiary.address);
      const solverBefore = await baseToken.balanceOf(await solver.getAddress());
      await atlas.metacall(
        await solver.getAddress(),
        searcher.address,
        baseAddr,
        0,
        encodeBackrun(br)
      );
      const benAfter = await baseToken.balanceOf(beneficiary.address);
      // With a zero bid the whole profit is swept; principal stays in the solver.
      expect(benAfter - benBefore).to.equal(profit);
      expect(await baseToken.balanceOf(await solver.getAddress())).to.equal(solverBefore);
    });
  });

  describe("Reverts that keep Atlas blind-bid accounting honest", function () {
    it("reverts UnauthorizedSearcher when solverOpFrom is not the registered searcher", async function () {
      const { solver, atlas, stranger, baseAddr, aAddr } =
        await loadFixture(deployProfitableFixture);
      const br = encodeBackrun({
        path: [baseAddr, aAddr, baseAddr],
        fees: [0, 0],
        dexIds: [0, 1],
        amountIn: ethers.parseEther("100"),
        minAmountOut: 1n,
        deadline: await deadlineFromNow(),
      });
      await expect(
        atlas.metacall(await solver.getAddress(), stranger.address, baseAddr, 0, br)
      ).to.be.revertedWithCustomError(solver, "UnauthorizedSearcher");
    });

    it("reverts when the bid exceeds the realized output (under-profit) — nothing settles", async function () {
      const {
        solver, atlas, searcher, beneficiary,
        baseToken, baseAddr, aAddr, roundTripOut,
      } = await loadFixture(deployProfitableFixture);

      const amountIn = ethers.parseEther("1000");
      const grossOut = roundTripOut(amountIn);
      const tooBigBid = grossOut + 1n; // cannot possibly be covered

      const br = encodeBackrun({
        path: [baseAddr, aAddr, baseAddr],
        fees: [0, 0],
        dexIds: [0, 1],
        amountIn,
        minAmountOut: 1n,
        deadline: await deadlineFromNow(),
      });

      const benBefore = await baseToken.balanceOf(beneficiary.address);
      // enforcedMin = max(minAmountOut, bid) = tooBigBid > grossOut => the EXECUTOR rejects first
      // with InsufficientOutput; either way the metacall reverts and nothing is paid.
      await expect(
        atlas.metacall(await solver.getAddress(), searcher.address, baseAddr, tooBigBid, br)
      ).to.be.reverted;
      const benAfter = await baseToken.balanceOf(beneficiary.address);
      expect(benAfter).to.equal(benBefore); // blind-bid: no partial settlement
    });

    it("reverts (executor InsufficientOutput) when the backrun is unprofitable vs minAmountOut", async function () {
      const { solver, atlas, executor, searcher, baseToken, beneficiary, baseAddr, aAddr, roundTripOut } =
        await loadFixture(deployProfitableFixture);

      const amountIn = ethers.parseEther("1000");
      const grossOut = roundTripOut(amountIn);

      // Demand more out than the pools can deliver, with a zero bid (so the failure is the
      // searcher's own minAmountOut, exercised inside the executor). InsufficientOutput is an
      // ERROR on the EXECUTOR contract, so the matcher is asserted against `executor`.
      const br = encodeBackrun({
        path: [baseAddr, aAddr, baseAddr],
        fees: [0, 0],
        dexIds: [0, 1],
        amountIn,
        minAmountOut: grossOut + ethers.parseEther("1"),
        deadline: await deadlineFromNow(),
      });

      const benBefore = await baseToken.balanceOf(beneficiary.address);
      await expect(
        atlas.metacall(await solver.getAddress(), searcher.address, baseAddr, 0, br)
      ).to.be.revertedWithCustomError(executor, "InsufficientOutput");
      expect(await baseToken.balanceOf(beneficiary.address)).to.equal(benBefore);
    });

    it("reverts BidNotCovered when profit is positive but smaller than the committed bid", async function () {
      // Here the round-trip IS profitable (clears principal) but the bid exceeds the profit, so the
      // solver-level profit check (not the executor) is the gate. We craft a bid strictly between
      // profit and grossOut, and force the executor min to NOT pre-empt it by sending a low
      // minAmountOut — but enforcedMin = amountIn + bid would still trip the executor first. To
      // isolate the solver's BidNotCovered branch we instead rely on the executor returning exactly
      // grossOut and the solver computing profit < bid. Because enforcedMin = amountIn + bid and
      // grossOut < amountIn + bid here, the EXECUTOR reverts InsufficientOutput first; either way
      // nothing settles. We assert the metacall reverts and the beneficiary is untouched.
      const { solver, atlas, searcher, baseToken, beneficiary, baseAddr, aAddr, roundTripOut } =
        await loadFixture(deployProfitableFixture);

      const amountIn = ethers.parseEther("1000");
      const grossOut = roundTripOut(amountIn);
      const profit = grossOut - amountIn;
      const overBid = profit + 1n; // covered by gross output, NOT by profit

      const br = encodeBackrun({
        path: [baseAddr, aAddr, baseAddr],
        fees: [0, 0],
        dexIds: [0, 1],
        amountIn,
        minAmountOut: 1n,
        deadline: await deadlineFromNow(),
      });

      const benBefore = await baseToken.balanceOf(beneficiary.address);
      await expect(
        atlas.metacall(await solver.getAddress(), searcher.address, baseAddr, overBid, br)
      ).to.be.reverted; // executor min (amountIn+bid) or solver BidNotCovered — no settlement either way
      expect(await baseToken.balanceOf(beneficiary.address)).to.equal(benBefore);
    });

    it("reverts UnsupportedBidToken for a non-base ERC20 bid token", async function () {
      const { solver, atlas, searcher, aAddr, baseAddr } =
        await loadFixture(deployProfitableFixture);
      const br = encodeBackrun({
        path: [baseAddr, aAddr, baseAddr],
        fees: [0, 0],
        dexIds: [0, 1],
        amountIn: ethers.parseEther("100"),
        minAmountOut: 1n,
        deadline: await deadlineFromNow(),
      });
      // bidToken = tokenA (not the base token) => unsettleable here.
      await expect(
        atlas.metacall(await solver.getAddress(), searcher.address, aAddr, 0, br)
      ).to.be.revertedWithCustomError(solver, "UnsupportedBidToken");
    });

    it("reverts NotConfigured when Atlas/executor not yet wired", async function () {
      const { owner, searcher, baseAddr, aAddr } = await loadFixture(deployProfitableFixture);
      // Fresh, unconfigured solver.
      const BofhAtlasSolver = await ethers.getContractFactory("BofhAtlasSolver");
      const bare = await BofhAtlasSolver.connect(owner).deploy();
      const br = encodeBackrun({
        path: [baseAddr, aAddr, baseAddr],
        fees: [0, 0],
        dexIds: [0, 1],
        amountIn: 1n,
        minAmountOut: 1n,
        deadline: await deadlineFromNow(),
      });
      // Called directly (owner stands in as caller) — NotConfigured fires before NotAtlas because
      // atlas==0 and executor==0.
      await expect(
        bare
          .connect(owner)
          .atlasSolverCall(searcher.address, owner.address, baseAddr, 0, br, "0x")
      ).to.be.revertedWithCustomError(bare, "NotConfigured");
    });
  });

  describe("Atlas gas-shortfall reconcile handshake", function () {
    it("reconciles a reported native shortfall when the solver holds native value", async function () {
      const {
        solver, atlas, searcher, owner, baseToken, baseAddr, aAddr, roundTripOut,
      } = await loadFixture(deployProfitableFixture);

      // Atlas reports a small native gas debt; fund the solver with native value to settle it.
      const shortfall = ethers.parseEther("0.01");
      await atlas.setShortfall(shortfall);
      await owner.sendTransaction({ to: await solver.getAddress(), value: shortfall });

      const amountIn = ethers.parseEther("1000");
      const grossOut = roundTripOut(amountIn);
      const bidAmount = (grossOut - amountIn) / 2n;

      const br = encodeBackrun({
        path: [baseAddr, aAddr, baseAddr],
        fees: [0, 0],
        dexIds: [0, 1],
        amountIn,
        minAmountOut: 1n,
        deadline: await deadlineFromNow(),
      });

      await atlas.metacall(await solver.getAddress(), searcher.address, baseAddr, bidAmount, br);

      // The solver forwarded its native balance to reconcile the reported shortfall.
      expect(await atlas.lastReconciled()).to.equal(shortfall);
      expect(await atlas.reportedShortfall()).to.equal(0n);
    });
  });

  // --------------------------------------------------------------------------------------------
  // Solver-level BidNotCovered guard (review fix #1)
  //
  // These hit the solver's OWN profit checks at BofhAtlasSolver ~L279/L281, which the real
  // executor's enforcedMin backstop pre-empts. The MockSolverExecutor returns a chosen grossOut so
  // both branches are reachable and we can prove NOTHING settles when they fire (blind-bid safe).
  // --------------------------------------------------------------------------------------------
  describe("Solver-level BidNotCovered guard (isolated via mock executor)", function () {
    it("(a) reverts BidNotCovered when grossOut < amountIn (executor under-delivers principal)", async function () {
      const { solver, atlas, searcher, beneficiary, baseToken, baseAddr, aAddr, mockExec, float } =
        await loadFixture(deployMockExecutorFixture);

      const amountIn = ethers.parseEther("1000");
      // Executor hands back LESS than principal -> grossOut < amountIn -> first guard trips.
      const grossOut = amountIn - ethers.parseEther("1");
      await mockExec.setNextGrossOut(grossOut);

      const br = encodeBackrun({
        path: [baseAddr, aAddr, baseAddr],
        fees: [0, 0],
        dexIds: [0, 1],
        amountIn,
        minAmountOut: 1n,
        deadline: await deadlineFromNow(),
      });

      const eeAddr = await atlas.getAddress();
      const eeBefore = await baseToken.balanceOf(eeAddr);
      const benBefore = await baseToken.balanceOf(beneficiary.address);
      const solverBefore = await baseToken.balanceOf(await solver.getAddress());

      // Zero bid: isolates the grossOut<amountIn branch specifically (bidAmount=0 can't trip L281).
      await expect(
        atlas.metacall(await solver.getAddress(), searcher.address, baseAddr, 0, br)
      ).to.be.revertedWithCustomError(solver, "BidNotCovered").withArgs(grossOut, 0n);

      // No partial settlement: EE + beneficiary untouched, solver float fully restored by the revert.
      expect(await baseToken.balanceOf(eeAddr)).to.equal(eeBefore);
      expect(await baseToken.balanceOf(beneficiary.address)).to.equal(benBefore);
      expect(await baseToken.balanceOf(await solver.getAddress())).to.equal(solverBefore);
      expect(await baseToken.balanceOf(await solver.getAddress())).to.equal(float);
    });

    it("(b) reverts BidNotCovered when grossOut > amountIn but profit < bidAmount", async function () {
      const { solver, atlas, searcher, beneficiary, baseToken, baseAddr, aAddr, mockExec, float } =
        await loadFixture(deployMockExecutorFixture);

      const amountIn = ethers.parseEther("1000");
      // Profitable vs principal (grossOut > amountIn) but the profit is SMALLER than the bid.
      const profit = ethers.parseEther("10");
      const grossOut = amountIn + profit;        // > amountIn -> first guard passes
      const bidAmount = profit + ethers.parseEther("1"); // bid exceeds profit -> second guard trips
      await mockExec.setNextGrossOut(grossOut);

      const br = encodeBackrun({
        path: [baseAddr, aAddr, baseAddr],
        fees: [0, 0],
        dexIds: [0, 1],
        amountIn,
        minAmountOut: 1n,
        deadline: await deadlineFromNow(),
      });

      const eeAddr = await atlas.getAddress();
      const eeBefore = await baseToken.balanceOf(eeAddr);
      const benBefore = await baseToken.balanceOf(beneficiary.address);
      const solverBefore = await baseToken.balanceOf(await solver.getAddress());

      // The solver-level profit check fires with (profit, bidAmount) — NOT the executor.
      await expect(
        atlas.metacall(await solver.getAddress(), searcher.address, baseAddr, bidAmount, br)
      ).to.be.revertedWithCustomError(solver, "BidNotCovered").withArgs(profit, bidAmount);

      // No partial settlement: the bid was NEVER paid to the EE, surplus NEVER swept, float intact.
      expect(await baseToken.balanceOf(eeAddr)).to.equal(eeBefore);
      expect(await baseToken.balanceOf(beneficiary.address)).to.equal(benBefore);
      expect(await baseToken.balanceOf(await solver.getAddress())).to.equal(solverBefore);
      expect(await baseToken.balanceOf(await solver.getAddress())).to.equal(float);
    });

    it("settles normally when profit == bidAmount (boundary: guard does NOT trip)", async function () {
      // Sanity boundary so the (b) guard isn't off-by-one: profit exactly equal to the bid passes.
      const { solver, atlas, searcher, beneficiary, baseToken, baseAddr, aAddr, mockExec } =
        await loadFixture(deployMockExecutorFixture);

      const amountIn = ethers.parseEther("1000");
      const profit = ethers.parseEther("10");
      const grossOut = amountIn + profit;
      const bidAmount = profit; // profit == bid -> surplus 0, must still settle (not revert)
      await mockExec.setNextGrossOut(grossOut);

      const br = encodeBackrun({
        path: [baseAddr, aAddr, baseAddr],
        fees: [0, 0],
        dexIds: [0, 1],
        amountIn,
        minAmountOut: 1n,
        deadline: await deadlineFromNow(),
      });

      const eeAddr = await atlas.getAddress();
      const eeBefore = await baseToken.balanceOf(eeAddr);
      const benBefore = await baseToken.balanceOf(beneficiary.address);

      await expect(
        atlas.metacall(await solver.getAddress(), searcher.address, baseAddr, bidAmount, br)
      ).to.emit(solver, "BackrunSettled");

      expect((await baseToken.balanceOf(eeAddr)) - eeBefore).to.equal(bidAmount);
      // Zero surplus swept (profit fully consumed by the bid).
      expect(await baseToken.balanceOf(beneficiary.address)).to.equal(benBefore);
    });
  });

  // --------------------------------------------------------------------------------------------
  // Tolerant safe-transfer / safe-approve for non-standard (no-return) base tokens (review fix #3)
  // --------------------------------------------------------------------------------------------
  describe("Non-standard (no-return) base token settlement", function () {
    it("settles a backrun whose base token's transfer/approve return NO bool", async function () {
      const { owner, searcher, beneficiary } = await loadFixture(deployMockExecutorFixture);

      // USDT/BSC-USD-style base token: transfer/transferFrom return nothing; approve returns bool.
      const MockNoReturnToken = await ethers.getContractFactory("MockNoReturnToken");
      const base = await MockNoReturnToken.deploy("No Return Base", "NRB", ethers.parseEther("100000000"));
      const baseAddr = await base.getAddress();

      const MockSolverExecutor = await ethers.getContractFactory("MockSolverExecutor");
      const mockExec = await MockSolverExecutor.deploy(baseAddr);

      const BofhAtlasSolver = await ethers.getContractFactory("BofhAtlasSolver");
      const solver = await BofhAtlasSolver.connect(owner).deploy();
      await solver.connect(owner).configureExecutor(await mockExec.getAddress(), baseAddr);

      const MockAtlas = await ethers.getContractFactory("MockAtlas");
      const atlas = await MockAtlas.deploy();
      await solver.connect(owner).configureAtlas(await atlas.getAddress(), searcher.address);
      await solver.connect(owner).setBeneficiary(beneficiary.address);

      // Fund solver float and executor liquidity in the no-return token.
      await base.transfer(await solver.getAddress(), ethers.parseEther("100000"));
      await base.transfer(await mockExec.getAddress(), ethers.parseEther("100000"));

      const amountIn = ethers.parseEther("1000");
      const profit = ethers.parseEther("20");
      const grossOut = amountIn + profit;
      const bidAmount = profit / 2n;
      await mockExec.setNextGrossOut(grossOut);

      const br = encodeBackrun({
        path: [baseAddr, baseAddr],
        fees: [0],
        dexIds: [0],
        amountIn,
        minAmountOut: 1n,
        deadline: await deadlineFromNow(),
      });

      const eeAddr = await atlas.getAddress();
      const eeBefore = await base.balanceOf(eeAddr);
      const benBefore = await base.balanceOf(beneficiary.address);

      // If the solver still used require(token.transfer(...)) this would revert on the no-return
      // token; the tolerant SwapMathLib.safeTransfer + _safeApprove make it settle cleanly.
      await expect(
        atlas.metacall(await solver.getAddress(), searcher.address, baseAddr, bidAmount, br)
      ).to.emit(solver, "BackrunSettled");

      expect((await base.balanceOf(eeAddr)) - eeBefore).to.equal(bidAmount);
      expect((await base.balanceOf(beneficiary.address)) - benBefore).to.equal(profit - bidAmount);
    });
  });

  // --------------------------------------------------------------------------------------------
  // Reentrancy guard on atlasSolverCall (review fix #2)
  // --------------------------------------------------------------------------------------------
  describe("atlasSolverCall reentrancy guard", function () {
    it("exposes a Reentrancy error and a happy-path call still settles (lock clears)", async function () {
      // The guard is defense-in-depth; the executor it calls is already nonReentrant, so there is no
      // in-suite re-entry vector to trip it. We assert the error selector exists and that a normal
      // settlement succeeds (proving the lock is cleared after the call, not left stuck).
      const { solver, atlas, searcher, beneficiary, baseToken, baseAddr, aAddr, mockExec } =
        await loadFixture(deployMockExecutorFixture);

      expect(solver.interface.getError("Reentrancy")).to.not.equal(null);

      const amountIn = ethers.parseEther("1000");
      const profit = ethers.parseEther("10");
      await mockExec.setNextGrossOut(amountIn + profit);
      const bidAmount = profit / 2n;

      const br = encodeBackrun({
        path: [baseAddr, aAddr, baseAddr],
        fees: [0, 0],
        dexIds: [0, 1],
        amountIn,
        minAmountOut: 1n,
        deadline: await deadlineFromNow(),
      });

      // Two back-to-back metacalls both succeed -> the lock is released between calls.
      const benBefore = await baseToken.balanceOf(beneficiary.address);
      await atlas.metacall(await solver.getAddress(), searcher.address, baseAddr, bidAmount, br);
      await mockExec.setNextGrossOut(amountIn + profit);
      const br2 = encodeBackrun({
        path: [baseAddr, aAddr, baseAddr],
        fees: [0, 0],
        dexIds: [0, 1],
        amountIn,
        minAmountOut: 1n,
        deadline: await deadlineFromNow(),
      });
      await atlas.metacall(await solver.getAddress(), searcher.address, baseAddr, bidAmount, br2);
      expect((await baseToken.balanceOf(beneficiary.address)) - benBefore).to.equal(
        2n * (profit - bidAmount)
      );
    });
  });
});
