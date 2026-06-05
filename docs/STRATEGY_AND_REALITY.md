# Strategy and Reality

**Audience:** the founding team
**Date:** 2026-06-05
**Status:** decision document — read before spending another engineering-week or a single audit dollar

This document merges three things: the verdict of the 6-expert panel, the "Reality" cleanup we just applied to the repo, and the web-grounded research on where a 2-3 person team can actually make money on-chain in 2025-2026. It is deliberately blunt. The point is to stop the project from lying to us, name the one bet worth making, and define the exact evidence that turns that bet into an audit (or a sunset).

---

## 1. What we made real this pass

Until this cleanup, the repo advertised a product it did not contain. The headline claim — "golden ratio (φ ≈ 0.618034) optimization for 4-way and 5-way swaps" — was **dead code with zero production callers**. The only things that ever called the optimization math were test mocks. We were maintaining, documenting, and (worse) believing in a feature that never ran.

This pass removed the lie. Concretely:

**Dead code stripped (suite still green: 326 passing, 0 failing, 4 pending; compiles clean):**

- `MathLib.calculateOptimalAmount` — the golden-ratio amount-distribution function. Zero production callers.
- `MathLib.geometricMean` — used only by a test mock.
- `MathLib.GOLDEN_RATIO` and `GOLDEN_RATIO_SQUARED` constants — the namesake of the whole false story.
- `PoolLib.calculateOptimalSwapAmount` — zero production callers, only a test mock.
- The corresponding mock wrappers (`MathLibTest`, `PoolLibTest`) and their `Libraries.test.js` describe blocks.
- Two **dead cumulative price-impact gates** in `BofhContractV2` (`_executeSwapToRecipient` legacy path and `_executeSwapMultiDex`). These computed `priceImpact = (cumulativeImpact * PRECISION) / amountIn` and reverted with `ExcessiveSlippage()` — but the math was broken and the gate was never the real protection. The live per-hop `validateSwap` cap is unchanged and remains in force.

**False claims corrected, so the repo stops describing a product it isn't:**

- `contracts/main/BofhContractV2.sol` header: rewritten from "golden ratio (phi) optimization for 4/5-way swaps" to an accurate description — a **sequential constant-product (x·y=k) multi-hop / multi-DEX atomic executor with per-hop fee correctness**.
- `contracts/libs/PoolLib.sol` header: "swap optimization" → "per-hop swap validation".
- `README.md`: title, subtitle, feature bullets, architecture diagram/table, the "Golden Ratio Optimization" math section, the implementation list, the footer, and a gas-table cell — all corrected to describe a **non-custodial sequential CPMM multi-hop / multi-DEX executor**.
- `docs/SWAP_ALGORITHMS.md`: retitled, with a prominent correction notice that golden-ratio optimization was never wired into production and has been removed. (The historical academic body — ~25 mentions — is retained below the notice and flagged as historical rather than deleted, to keep the diff scoped. **It should be removed entirely in a follow-up.**)
- `docs/ARCHITECTURE.md`: the "Path optimization" and "Optimization algorithms" bullets corrected to reflect single-pass hop execution with **no on-chain optimization**.
- `test/SwapExecution.test.js`: misleading "golden ratio" test titles renamed to describe the real multi-hop swap execution they actually exercise (the tests were kept — they test live swaps).

**One structural security improvement landed in the same pass:** ownership is now **Ownable-2-step**. `transferOwnership` only nominates a `pendingOwner` and emits `OwnershipTransferStarted`; the nominee must call `acceptOwnership` to take control. This prevents a fat-finger transfer to an address nobody controls — appropriate hardening for a contract that will eventually hold or route the team's own capital.

**Honest residue (tracked, not hidden):**

- `ExcessiveSlippage()` is now unused inside `BofhContractV2` but remains declared in `IBofhContract.sol`. Left untouched to avoid an ABI change; no compile impact.
- `log2` in `MathLib` is now only reachable via its test mock, but it's a legitimate fixed-point primitive paired with the production-used `exp2`. Kept, in scope.
- `SQRT_PRECISION` / `CBRT_PRECISION` were already unused before this pass. Left as-is.
- `SwapExecuted` now emits the **raw** cumulative price-impact sum instead of the previously-broken divided value. No test asserted the old number; the per-hop cap is unchanged. This is an analytics-field shape change worth noting for any downstream consumer.

**Net effect:** the contract now says what it is. It is a clean, tested, non-custodial, multi-V2-fork atomic executor. It is **not** an optimizer, and it never was. Everything below proceeds from that corrected baseline.

---

## 2. The honest verdict

**The contract is the commodity. The edge is off-chain, and it does not exist yet.**

Stated plainly, as the panel did:

1. **As a competitive arbitrage tool, the contract does not make sense on its own.** It is gas-heavy (~2-3× a Huff/Yul executor), V2-only, has no flash loans (so capital must be held on-chain, at risk, fragmented across pairs), and its advertised optimization was dead code. On contested liquid pairs, public-mempool arb is won on **gas-bid and latency**, not on a nicer Solidity executor. There, this contract is a liability, not an advantage.

2. **The money-making edge is 100% off-chain** — fast new-pair discovery, a real cross-fork path-finder over live reserves, decent (not co-located) latency, and private inclusion. **None of it is in this repo.** `scripts/find-arbitrage.js` is confirmed a mock-pool demo: it deploys `MockPair`/`MockFactory`, manually transfers tokens to fabricate imbalances, hardcodes `fee=3` (wrong across forks), and loops `executeSwap` over hardcoded paths. No reserve indexer, no mempool/event listener, no path solver, no bundle submission, no live reserves.

3. **Therefore we have a settlement layer and no strategy.** A settlement layer is necessary but not sufficient and — critically — **easily replaceable**. The thing that would make money (the off-chain edge) is the thing we have not built and have not proven.

The trap to avoid: "refocusing" by polishing the contract first. That repeats the original mistake. We do not have a contract problem. We have an **unproven-edge** problem. Polishing or auditing the executor before the edge is proven is spending money to make the commodity shinier while the moat is still vaporware.

---

## 3. Where the money realistically is

The research is unambiguous: **every measured on-chain extraction market in 2025-2026 is an oligopoly.** The questions that matter for us are (a) which corners are *not* yet captured, and (b) which of those make our existing asset *the right tool* rather than dead weight.

### The ranked landscape

| Rank | Strategy | Competition | Small-team fit | Uses our executor? | Verdict |
|---|---|---|---|---|---|
| **#1** | **Long-tail / fresh-launch V2-fork backrunning** (thin/under-contested chains) | soft | high | **Yes — best fit** | **RECOMMENDED** |
| **#2** | Auction / OEV backrunning (Polygon FastLane-Atlas, Chainlink SVR, BSC bundles) | high | medium | No (executor irrelevant) | **HEDGE / fallback** |
| 3 | Liquidation keeping (smaller/newer lending markets) | high | medium | Swap-leg only | Event-driven, bursty |
| 4 | Cross-V2-fork atomic arb on *contested liquid* pairs | brutal | low | Best-shape, currently a liability | Money-loser for us |
| 5 | CEX-DEX arbitrage | brutal | low | Irrelevant | Closed to us |
| 6 | Cross-chain inventory arb | high | low | Irrelevant | Capital/inventory game |
| 7 | JIT V3 liquidity provision | high | low | Wrong architecture (V3) | ~0.007% ROI; not for us |
| 8 | Long-tail sniping / copy-trade bots | brutal | medium | Irrelevant | Speculation, not arb |

### The brutal reasons most of these are losing games for us

- **CEX-DEX (#5)** is the biggest category ($233.8M extracted Aug-2023→Mar-2025) and the most closed. Top 3 searchers take ~90% of value; they keep only ~10-15% and pay ~90% to integrated builders. No builder integration = you don't win blocks. We have no CEX inventory, no pricing engine, no co-location, no builder relationship. Entry path: none.
- **Contested atomic V2 arb (#4)** is literally what our contract is *for*, and it's exactly the losing pattern Flashbots' "limits of scaling" describes: blind on-chain V2 search burns ~130M gas per successful arb (a documented bot sends ~350 failed txs per win — a ~650× efficiency gap vs reading state privately). BSC block construction is ~80%+ two builders (Blockrazor + 48Club); Base is ~2 entities doing 80%+ of blocks. Independent searchers retain ~17% of profit. Our gas-heavy, blind, capital-holding executor is built to lose this specific race.
- **Cross-chain (#6)** has wider spreads (0.3-5%) but ~67% of arbs use pre-positioned dual-chain inventory; >50% of trades trace to 5 addresses. The wide spread is compensation for capital fragmentation, bridge/finality risk, and adverse selection — not free money. Our single-chain atomic executor can't make a cross-chain trade atomic.
- **JIT V3 (#7)**: ~0.007% average ROI, needs tens of millions deployed per opportunity, wrong architecture (V3 ticks, not V2 CPMM). Nothing transfers.
- **Retail sniping (#8)** is directional speculation, not market-neutral extraction. >60% of participants lose. Copy-trading makes you a KOL's exit liquidity. The tooling layer is saturated by funded incumbents.
- **OEV / liquidations (#2, #3)** are genuinely permissionless and winnable on bid-math — but Chainlink SVR liquidation recapture is already **>80% with many onboarded searchers** (late and crowded), and in these venues you bid *into someone else's ordering* via EIP-712 bundles, so **our executor contributes nothing to the win condition.** Good hedge, bad reason to keep the contract.

### Why #1 is the call

**Long-tail / fresh-launch V2-fork backrunning** is the only strategy that satisfies all three conditions at once:

1. **It is genuinely under-contested in 2026.** Competition on the true long tail is documented as roughly *two orders of magnitude lighter* than mainstream liquidity. There is no Priority Gas Auction on a pool the top 2-3 spam-bots per chain don't bother to model. The edge is **breadth and freshness of pool coverage**, which is a software problem a small team can win — not a nanosecond co-location problem it can't.

2. **It makes our existing, paid-for asset the correct tool.** V2-fork-only is a *feature* here — the long tail *is* V2 forks (Base memecoin flow, BNB four.meme / Binance Alpha launches, PancakeSwap-V2 forks fragmented across ~10 networks). Atomicity gives exactly the revert-protection these risky pools demand. We strip the dead code and trim gas, but we **reuse** the core, we don't discard it.

3. **The off-chain moat is buildable by us.** Fast `PairCreated`/`Sync` discovery across many forks + a multi-hop cyclic solver over live reserves + private inclusion (48 Club / bloXroute on BSC, private RPC on Base) is real engineering, not capital or latency arms-racing.

**The honest downside of #1, stated up front:** profits are *small and lumpy* (tens to low-hundreds of dollars per trade), partly eaten by gas + inclusion bribe. The realistic outcome is a **modest, irregular income stream on the team's own capital — not a fund.** And the single make-or-break risk is **adverse selection / honeypots**: long-tail pools are riddled with transfer-tax, blacklist, rug, and fake-reserve tokens. A backrun that buys an unsellable token is a 100% loss. A robust token-safety / `eth_call` revert-guard simulation layer is **mandatory** and is the make-or-break, not a nice-to-have.

**#2 (Auction/OEV) is the explicit hedge.** If the long-tail edge proves too thin, OEV backrunning (especially Polygon FastLane-Atlas, which has a smaller ~17-searcher pool and is more open than SVR) is the fallback. But choosing #2 means **accepting the executor as sunk cost** — so we only pivot there if #1 fails its kill-criteria.

---

## 4. The research system

We scaffolded a read-only off-chain pipeline in a new top-level **`research/`** directory (independent of `contracts/`). Its single job: answer **one question on real data** —

> *On our target thin/under-contested chains, do round-trip baseToken cycles across V2-fork pools clear a profit AFTER gas, priority fee, slippage, and a realistic win-rate haircut — often enough and large enough to matter?*

If yes → strip and audit the contract. If no → kill the project before audit spend. The contract stays untouched and unaudited until this pipeline returns GO.

### What's scaffolded (and what's honestly still a TODO)

All files pass `node --check`; the offline demo runs end-to-end (`node research/run.js --demo`).

| File | Stage | Real now | Honestly TODO |
|---|---|---|---|
| `research/README.md` | — | Panel verdict, methodology, per-stage table, run/ops notes | — |
| `research/config.example.json` | — | Target chains (BSC on; Base/Polygon stubbed), RPC env-var names, per-fork factories + **per-fork feeBps**, Multicall3, base tokens, scan/pathfinder/gas/kill params | — |
| `research/config.js` | — | Dependency-light loader; resolves RPCs from env only; warns on factory drift | — |
| `research/scanner.js` | 1 | **Real** `getReserves()`/`token0()`/`token1()` + factory `allPairsLength()` probe; writes versioned pool snapshot; `seedPairs` fast-path | Full `PairCreated` replay / `allPairs(i)` + Multicall3 enumeration; **on-chain per-fork fee verification** |
| `research/pathfinder.js` | 2 | **Real** directed token graph (weight `= -ln(fee-adjusted rate)`), Bellman-Ford negative-cycle detection anchored at baseToken, 2-5 hop candidates | — (correctly documented as **candidate generator only** — cannot net absolute gas) |
| `research/backtester.js` | 3+4 | **Real** optimal-input sizing (geometric grid + ternary refine over BigInt CPMM), net-of-gas PnL priced for **both** the fat `BofhContractV2` and a lean Huff target, explicit `applyKillCriteria` → KILL / GO(PROVISIONAL) | **revm/Anvil re-simulation** against real historical state; **live-shadow win/revert-rate** measurement |
| `research/gasModel.js` | 3 | Per-hop gas constants for fat-vs-lean executors, effective gas price incl. priority/bribe, `compareExecutors` helper | Constants are **clearly-marked PLACEHOLDERS** — must be measured |

Two real bugs were found and fixed during smoke-testing, which is exactly why we build this before trusting any number:

1. A Bellman-Ford early-break that conflated *convergence* with *absence of a negative cycle* → rewritten to standard V-1 relaxation passes + a separate detection pass.
2. A degenerate optimal-input search on a *linear* grid that missed the true optimum → rewritten to a geometric/log-spaced grid + ternary refine.

### The kill-criteria methodology

The pipeline is **kill-criteria-driven**, not demo-driven. It runs in two modes:

- **(A) Historical backtest** — sweep N blocks of real history (archive node = ground truth), reconstruct reserves per block, find + size + simulate cycles, record net PnL *assuming you'd have landed the tx*, then apply a realistic win-rate/latency haircut.
- **(B) Live shadow** — run the live scanner for weeks **signing nothing**, log every opportunity it *would* have taken, then inspect the next block to see whether a competitor took it (you lost the race) or it would have reverted.

It reports: **net profit/opportunity, opportunities/day, gross-vs-net spread, win-rate, revert rate, capital-at-risk, Sharpe.**

**KILL the project if, on the best target chain over a representative window, ANY of:**

1. Median **net-of-gas profit/opportunity < 2-3× total frictions** (fees + gas + bribe).
2. Realistic **win-rate so low that expected daily net < infra + capital cost.**
3. The edge exists **only for a lean Huff executor**, never for a realistic executor at our gas profile — meaning we'd have to win the rewrite arms race just to break even.
4. **Revert/loss rate** lands in the bad regime (the literature shows 5-40% daily revert on fast-finality rollups; honeypots compound this) and wipes expected value.

**Backtesting hygiene (non-negotiable, baked into the harness):** model **2× historical spread as slippage**; add latency; expect **live drawdown 1.5-2× backtest** and **live Sharpe ~1 point lower** than backtest. **Treat a backtest Sharpe > 3 as overfitting, not success.** The archive-node ground truth + revm re-simulation exist specifically to kill look-ahead and state-staleness bias — the two failure modes that make a backtest lie in our favor.

### Stack and sequencing

- **Stage 0 (data plane):** self-host a Reth/Erigon archive node per target chain as the single source of truth so backtest and live read byte-identical state; commercial RPC (QuickNode/Alchemy/Chainstack/Dwellir) only as fallback/bootstrap. Batch reads via Multicall3.
- **Language:** Python (`web3.py`, the existing `bofh/` package) for the scanner / registry / path-finder prototype / kill-criteria notebooks; **Rust (Alloy + revm)** only for the proven hot loop (the microsecond simulator). Don't port to Rust until Python proves the loop is worth porting.
- **Storage:** Postgres or Parquet for the pool registry + opportunity log; pandas/Jupyter for the report.

---

## 5. Decision gates

The sequencing is fixed and must not be reordered:

```
  PROVE the off-chain edge  →  STRIP the contract  →  AUDIT last
  (research/ on real data)     (dead code, gas)       (only on GREEN)
```

We do not strip the contract for production until the edge is proven. We do not pay for an audit until the contract is stripped *and* the edge is proven. Spending audit money on an unproven strategy is lighting money on fire to certify a commodity.

### GO → greenlight stripping, then audit

Proceed only when **all** hold on the best target chain over a representative window:

- Median net-of-gas profit/opportunity **≥ 2-3× total frictions**, sustained.
- Live-shadow **win-rate × opportunities/day** yields **expected daily net > infra + capital cost** with margin.
- Profitable at a **realistic (not Huff-only) executor gas profile** — i.e., a modest gas trim makes it work; we don't need to win a Huff arms race to break even.
- **Revert/honeypot loss rate** controlled by the token-safety guard to a level that doesn't wipe EV.
- Backtest survives the hygiene haircuts (2× slippage, latency, live-Sharpe −1) and is **not** in the Sharpe>3 overfit zone.

Then, and only then: strip `BofhContractV2` for production (remove the now-unused `ExcessiveSlippage` from the interface, finish removing the historical golden-ratio doc body, trim gas, evaluate adding flash loans *only if the data says capital-holding is the binding constraint*), and **audit last** on the stripped, proven configuration.

### KILL → sunset

Trigger a sunset if any single KILL criterion from §4 fires and cannot be remedied within the research window:

- Net edge below the friction multiple, or
- Win-rate too low for positive expected daily net, or
- Edge is Huff-only at our realizable gas profile, or
- Revert/honeypot losses dominate.

A KILL is **not** a failure of the team — it is the research system doing its job *before* we spent on an audit. The contract code (now honest and tested) remains a clean reusable artifact; the conclusion is simply that the off-chain edge isn't there at a size that matters, and we stop.

**One caveat on the GO bar:** win-rate is impossible to estimate perfectly without actually racing. If live-shadow looks green but win-rate is the only uncertain input, a **tiny real-capital pilot** (smallest sizes, a handful of trades) to confirm landing rate is acceptable *before* committing to a full GO and an audit — but that pilot is the most we spend until the number is confirmed.

---

## 6. Immediate next 2 weeks

Ordered. Do them in this sequence.

1. **Pick the single target chain and base token.** Default to **BSC** (already enabled in `research/config.example.json`; thin four.meme / Binance Alpha long-tail flow; 48 Club / bloXroute private inclusion available). Set `enabled: true`, copy to `research/config.json` (gitignored), and confirm WBNB as base token.
2. **Stand up the data plane (Stage 0).** Bootstrap on a commercial archive RPC (QuickNode/Chainstack/Dwellir) to start *today*; in parallel begin provisioning a self-hosted Reth/Erigon archive box. Export the `RESEARCH_RPC_*` env vars. Verify the scanner's `allPairsLength()` probe connects.
3. **Finish Stage 1 pair enumeration + per-fork fee verification.** Replace the `seedPairs` fast-path with real `PairCreated` replay (or `allPairs(i)` backfill) + Multicall3 batched `getReserves`. **Read each fork's fee on-chain — do not hardcode** (the `fee=3` bug in the old mock script is exactly what produces phantom profit). Persist the pool registry.
4. **Wire revm/Anvil re-simulation into `backtester.js` (Stage 3).** This is the most load-bearing TODO: without it, pure-formula CPMM overstates profit and silently ignores reverts and honeypots. Re-simulate each candidate path against real historical state.
5. **Build the token-safety / honeypot guard.** An `eth_call` buy-then-sell revert-simulation that rejects transfer-tax, blacklist, fake-reserve, and unsellable tokens. This is the make-or-break risk for #1 — treat it as a first-class component, not a filter.
6. **Measure real gas constants** for `BofhContractV2` (via `REPORT_GAS`) and for a lean Huff/Yul reference, and load them into `gasModel.js` to replace the placeholders. This is what makes the "Huff-only edge?" kill-criterion real.
7. **Run a 2-4 week historical backtest, then start the live-shadow window.** Sign nothing. Log every would-be opportunity; check the next block for competitor capture and reverts. Produce the kill-criteria report (net profit/opp, opps/day, win-rate, revert rate, Sharpe) in a pandas/Jupyter notebook.
8. **Convene a GO/KILL decision review at the end of week 2** against the §5 gates. Default posture: **KILL unless the data clears the GO bar.** The burden of proof is on the edge, not on the skeptic.

**What we explicitly do NOT do in the next two weeks:** touch the audited-readiness of the contract, pay for an audit, add flash loans, rewrite in Huff, or build the Base/Polygon legs. None of that is justified until the BSC long-tail edge is proven on real data.
