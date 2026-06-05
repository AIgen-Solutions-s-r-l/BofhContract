# BofhContract — Off-Chain Research & Backtest Toolkit (`research/`)

> **Status: starter skeleton.** Real RPC enumeration and revm re-simulation are TODO'd.
> Everything compiles (`node --check`) and the offline Stage 2→4 pipeline runs today via
> `node research/run.js --demo`. This directory is **independent of `contracts/` and
> `test/`** and touches neither.

## Why this exists (read before writing any more contract code)

A 6-expert panel reviewed BofhContractV2 and concluded:

- As a **competitive arbitrage tool it does not make sense** today — it is ~2–3× the gas of
  a lean Huff/Yul executor, V2-only, has no flash loans, and forces you to hold capital.
- Its advertised **"golden ratio optimization" is dead code** (zero production callers; only
  test mocks invoke it).
- The real money-making edge is **off-chain** (fast pool discovery + a real cyclic
  path-finder + private inclusion), and **none of it exists in this repo**:
  `scripts/find-arbitrage.js` is a Hardhat **mock-pool demo** that fabricates reserves and
  loops `executeSwap` over hardcoded paths.

The verdict: **REFOCUS** to a non-custodial, multi-V2-fork atomic executor for the team's
own capital on **thin / under-contested EVM chains** — but **PROVE the off-chain edge on
real chain data FIRST**, then strip the contract, and **audit LAST**.

This toolkit is Step 1: the read-only off-chain pipeline that answers one question on real
data, **before any audit spend**:

> On our target thin/under-contested chains, do round-trip baseToken arbitrage cycles across
> V2-fork pools clear a profit **after gas, priority fee/bribe, slippage, and a realistic
> win-rate haircut** — often enough and large enough to matter?

If **yes** → strip + audit the contract. If **no** → **kill the project before spending on
an audit.**

## Kill-criteria-driven methodology

The whole pipeline is a gate, not a product. We never assume an edge; we make a `GO` hard to
earn. The decision lives in `backtester.js::applyKillCriteria` and the thresholds in
`config.*.json → kill`:

Before any candidate is even scored, the **token-safety GATE** (PLAY #4, `tokenSafety.js`)
runs a **per-token base<->token buy-then-sell probe** (one independent 2-hop `base->token->base`
round-trip for **each** distinct non-base token, not a single whole-cycle measurement) and
**drops** any candidate whose tokens include a honeypot / sell-blocked / over-taxed /
max-tx-limited one. Dropped candidates are **never sized, never fired**, and the
drop count surfaces in the verdict (`token-safety dropped : N`). On a fresh-pool run a high drop
rate is **expected and healthy** — long-tail pools are full of unsellable tokens.

A run is **KILL** if **any** of these trip:

1. **Margin too thin** — median net-of-gas profit per profitable op `< minNetProfitToFrictionRatio ×` friction.
2. **Sub-economic** — expected daily net (`ops/day × median net × realistic win-rate`) `< infraCostUsdPerDay`.
3. **Only a lean executor profits** — if **no** opportunity is profitable with the fat
   `BofhContractV2` but some are profitable with a lean Huff target, that is a signal to
   **strip/rewrite the contract**, not to proceed with the current one.
4. **Reverts dominate** — measured revert rate `> maxAcceptableRevertRate` (enforced only once
   revm/Anvil re-simulation is wired; until then the report prints a provisional-`GO` warning).
0. **Not representative** — fewer than `minOpportunitiesPerDay` profitable ops/day.

A `GO` is always **PROVISIONAL** until (a) revm re-simulation measures reverts/honeypots and
(b) a live-shadow window measures a real win-rate. Backtest hygiene to apply before trusting
any green: model ~2× historical spread as slippage, expect live drawdown 1.5–2× backtest, and
treat a backtest Sharpe > 3 as overfitting rather than success.

**Sequencing (matches the panel): prove the off-chain edge here → only then strip the contract → audit last.**

## Pipeline stages

| Stage | File | What it does | Real vs TODO |
|------|------|--------------|--------------|
| 0 Data plane | *(external)* | Self-host a Reth/Erigon archive node per chain so live + historical reads are byte-identical; commercial RPC only as fallback. | TODO (ops): see below. |
| 1 Scanner | `scanner.js` | Enumerate V2-fork pairs per factory, snapshot reserves + **per-fork** fee to a JSON pool snapshot. | `getReserves()/token0()/token1()` are **real** ethers v6 calls. Full enumeration (PairCreated replay / `allPairs(i)` + Multicall3) is **TODO**. |
| **1b Fresh-pool scanner** | `freshPoolScanner.js` | **PLAY #3.** Replay `PairCreated` logs over a recent block window, keep pools **younger than `maxAgeBlocks`**, snapshot reserves, and emit the **same snapshot shape** as `scanner.js` PLUS per-pool `createdBlock`/`ageBlocks`/`competitorCount`. Feeds the long-tail / fresh-pool backrun on a PGA chain. | `getLogs(PairCreated)` decode + age filter + reserve reads are **real** ethers v6 calls. getLogs range **chunking under provider caps + Multicall3** batching are **TODO** (same surface as `scanner.js`). |
| 2 Path-finder | `pathfinder.js` | Build the token graph, run Bellman-Ford **negative-cycle** detection seeded at baseToken to surface round-trip candidates (2–5 hops). **Pure function over a snapshot** → testable offline. | Real, working candidate generator. Exhaustive enumeration (Johnson / line-graph MMBF) is a noted upgrade. |
| **3-gate Token-safety** | `tokenSafety.js` | **PLAY #4 (highest priority).** A **per-token `base->token->base` buy-then-sell probe** (run independently for **each** non-base token, NOT a single whole-cycle measurement) that flags honeypots / sell-blocks / fee-on-transfer / transfer-tax / max-tx limits / post-launch fee-flips. Wired as a **HARD pre-fire GATE** in `backtester.runBacktest`: a candidate is **dropped and never fired** (and counted) if **any** of its tokens fails. Interface: `{ safe, reasons[], measuredSellTax, honeypot, maxTxSuspected, feeFlipRisk, fidelity }`. | **Real** per-token `eth_call` `getAmountsOut` base<->token round-trip approximation + clean-CPMM base<->token baseline + classifier. The honeypot/sell-revert signal needs no baseline (covers interior tokens too); the **exact forked-EVM buy-then-sell** (anvil/foundry/revm, state-override funding) is **TODO** (the `simulateOnFork` seam self-reports unimplemented). |
| 3 Sizing + net-of-gas | `backtester.js` + `sizing.js` | Size each **safe** cycle with the **liquidity-capped CPMM optimal-input sizer** (hard-capped by `reserveCapFraction` × thinnest hop reserve **and** a `maxPriceImpactBps` budget), simulate CPMM output, subtract per-hop fees **and** gas+priority fee priced for **both** the fat and lean executors. | Real CPMM math + real capped sizing (no naive sizing). **revm/Anvil re-simulation against historical state is TODO** (without it, pure formulas overstate profit). |
| 4 Paper-trade + KILL/GO | `backtester.js` | Apply explicit kill-criteria, emit the verdict + stats (now including `tokenSafetyDropped`). | Real. Win-rate/revert come from config until live-shadow + revm provide measured values. |
| — Gas-bid policy | `gasBidPolicy.js` | **PLAY #3.** Dynamic **priority-gas-auction** bid policy for Monad/HyperEVM: bid just above the marginal competitor, never above `maxBidFraction` × expected profit, **decline** when the auction has bid the EV away. Pure + testable. | Real, pure policy. A **live mempool competitor feed** to source `competitorBidGwei` is **TODO**. |
| — Gas model | `gasModel.js` | Documented per-hop gas constants for **this** executor vs a **lean** target so the strip decision is data-driven. | Constants are **PLACEHOLDERS** — replace with measured `REPORT_GAS` numbers. |
| — Config | `config.js` | Loads config, resolves RPC from **env vars only**, reuses `scripts/utils/addresses.js` for base tokens/factories, warns on address drift. | Real. |
| — Runner | `run.js` | Offline orchestrator: runs Stage 1b→4 over an existing/`--demo` snapshot with zero RPC. | Real. |

## Configure

1. Copy the example config and keep your real one out of git:

   ```bash
   cp research/config.example.json research/config.json   # config.json is gitignored
   ```

2. **RPC URLs are read from environment variables, never from the JSON.** Each chain entry
   names its env vars (`rpcEnv`, `rpcFallbackEnv`, `wsEnv`). Export them:

   ```bash
   export RESEARCH_RPC_BSC="https://your-bsc-archive-endpoint"
   export RESEARCH_RPC_BSC_FALLBACK="https://commercial-rpc-fallback"   # optional
   export RESEARCH_WS_BSC="wss://your-bsc-ws-endpoint"                  # optional, for live newHeads
   ```

3. Enable the chain(s) you want (`"enabled": true`) and tune `scan`, `pathfinder`, `gas`,
   and `kill`. Factory addresses mirror `scripts/utils/addresses.js`; `config.js` **warns on
   drift** so the canonical book stays the source of truth. Per-fork fees (`feeBps`) MUST be
   correct per DEX (PancakeV2 = 25, Biswap = 10, ApeSwap = 20, Uni/Sushi/Quick = 30) — do not
   hardcode one fee across forks (the bug in the old mock).

### Stage 0 (data plane) — operational TODO

For trustworthy backtests, stand up a **Reth or Erigon archive node** per target chain
(NVMe box, ~1.6TB+) so historical `getReserves` at any block and live `newHeads` come from
identical state. Use QuickNode/Alchemy/Chainstack/Dwellir only to bootstrap. Batch reads via
**Multicall3** (`0xcA11bde05977b3631167028862bE2a173976CA11`, already in the config). This
step has no code here on purpose — it is infra.

## PLAY #4 — token-safety guard (the gate that makes the fresh-pool play survivable)

`tokenSafety.js` runs a **per-token base<->token probe** — the 2-hop round-trip that actually
loses you money, measured **one token at a time** (NOT across a whole multi-hop cycle):

```
buy  baseToken --(base<->token pool)-->  token       (amountToken)
sell token     --(base<->token pool)-->  baseToken   (amountBaseBack)
```

This is deliberately scoped: a single 2-hop `base->token->base` probe is valid only for that
one token's direct base pool, so it is **never** treated as the round-trip tax of a longer
(3–5 hop) candidate. To make a multi-hop candidate safe, the GATE runs this probe
**independently for each distinct non-base token** on the path and drops the candidate if **any**
one fails (see `backtester.gateTokenSafety` / `tokenSafetyTargets`).

A clean token returns `amountBaseBack` ≈ input minus only the two V2 swap fees + price impact.
The guard computes the **clean CPMM base<->token baseline** (same math the backtester trusts, on
the **same** base<->token pool it quotes) and compares it to what the chain actually returns via
a real per-token `eth_call getAmountsOut([base,token])` then `getAmountsOut([token,base])`. The
residual, net of the fees already accounted for, is the **measured sell/transfer tax**. A
**revert on the sell leg** (with a healthy buy) is the honeypot signature — and that signal needs
**no baseline**, so it gates interior tokens of a longer cycle too. A tax that **jumps at a larger
probe size** flags a max-tx / anti-whale / graduated-launch tax. A **live owner** that could flip
fees post-launch is a soft `feeFlipRisk` (never a hard fail by itself).

**Interface (stable across fidelity levels):**
`checkToken(...) -> { safe, reasons[], measuredSellTax, honeypot, maxTxSuspected, feeFlipRisk, fidelity }`.

- **`fidelity: 'eth_call'`** — the implemented approximation (real per-token `getAmountsOut`
  over the `base<->token` 2-hop path). Catches sell-reverts (honeypots), pair-applied taxes, and
  size-dependent gates. It measures **one token's direct base round-trip**, not the full cycle;
  the measured tax is meaningful only for a token directly paired with base (the clean baseline
  is the same base<->token pool). Interior tokens with no direct base pool on the cycle still get
  the baseline-free honeypot/sell-revert check; an offline tax baseline for them (their real
  base<->token reserves) is a **TODO** (needs a pool lookup / RPC).
- **`fidelity: 'fork'`** — **TODO**: the exact buy-then-sell on a forked EVM (anvil/foundry/revm)
  that funds a throwaway EOA via state override and actually executes both legs. Only this catches
  holder-state / `tx.origin` / whitelist honeypots a stateless quote misses. `simulateOnFork()` is
  the seam and self-reports `implemented:false` so a number is never trusted that wasn't produced.
- **`fidelity: 'offline'`** — pure classification from injected/precomputed round-trips (tests/demo).

**Wired as a HARD gate:** `backtester.runBacktest` calls `gateTokenSafety` **before** sizing.
Unsafe candidates are dropped and counted (`tokenSafetyDropped`); they are **never sized or fired**.
Configure via `config.tokenSafety` (`router`, `maxSellTax`, `largeProbeMultiplier`, …).

## PLAY #3 — long-tail / fresh-pool backrun on a Priority-Gas-Auction chain

The durable edge in 2026 is **not** contesting the same fat pools every searcher watches — it's
being **first into a brand-new V2-fork pool** the moment liquidity lands, on a **thin, fast,
under-contested PGA chain (Monad / HyperEVM)** where inclusion is bought openly via the priority
fee (no sealed-bid OFA to plug into).

Three pieces implement this:

1. **`freshPoolScanner.js`** — replays `PairCreated` logs over a recent block window and keeps only
   pools **younger than `maxAgeBlocks`**. The creation block gives **freshness for free**. Output is
   a strict **superset** of a `scanner.js` snapshot (adds `createdBlock`, `ageBlocks`,
   `competitorCount` = #other pairs born in the same block on the same factory), so
   `pathfinder.js` + `backtester.js` consume it **unchanged**. Writes `snapshot.<chain>.fresh.json`.
2. **`sizing.js` (`optimalInputCapped`)** — the backtester now sizes every cycle with a
   **liquidity-capped** optimum: hard-capped by `reserveCapFraction` × the **thinnest** hop's
   reserve **and** by the largest size whose cumulative round-trip impact stays under
   `maxPriceImpactBps`. This replaces the old naive first-hop-reserve cap, which over-sizes
   catastrophically in thin fresh pools. The report shows which cap bound the size (`sizeBoundBy`).
3. **`gasBidPolicy.js`** — the PGA bid policy: bid just above the marginal competitor
   (`outbidIncrement`), never above `maxBidFraction` × expected profit, floor at the chain minimum,
   and **decline** the op entirely when winning would cost more than the EV (`shouldBid → false`).
   Pure functions (`computeBid`, `shouldBid`, `profitToMaxBidGwei`) — unit-test targets.

### ⚠️ GATE-0 (must verify LIVE before any deploy/bond)

Chainlink **acquired Atlas (22 Jan 2026)** and pivoted toward SVR-liquidation flow. The
permissionless DEX-backrun OFA's continued openness — and that your chosen PGA chain is genuinely
**under-contested** — **MUST be verified with a live-shadow run before bonding any capital.** The
toolkit **signs nothing**; treat every `GO` as provisional until live-shadow + the forked-EVM
re-sim (Stage 3 ground truth) measure a real win-rate and revert rate.

### Monad / HyperEVM config

`monad` and `hyperevm` entries are added to `config.example.json` **disabled, with PLACEHOLDER
chainId / factory / wrapped-native addresses** — they are **not** in `scripts/utils/addresses.js`,
so `config.js` resolves their base token to `null`. **You must fill the real addresses + per-fork
`feeBps` from each chain's docs and verify them on-chain before enabling.** Tune `freshScan`
(`lookbackBlocks`, `maxAgeBlocks`) to the chain's block time — a few thousand blocks is *minutes*
on a fast PGA chain.

## Run each stage

```bash
# Offline smoke test (no RPC needed): runs path-finder + backtester over a synthetic snapshot
node research/run.js --demo

# Stage 1: scan configured chains -> writes research/data/snapshot.<chain>.json
#   (needs RPC env vars + "seedPairs" in config until full enumeration is implemented)
node research/scanner.js

# Stage 1b (PLAY #3): fresh-pool scan via PairCreated replay -> snapshot.<chain>.fresh.json
#   (needs RPC env vars; keeps only pools younger than freshScan.maxAgeBlocks)
node research/freshPoolScanner.js

# Stage 1b->4: replay a fresh-pool snapshot through path-finder + token-safety gate + backtester
node research/run.js research/data/snapshot.bsc.fresh.json

# Stage 2-4: replay an existing snapshot through path-finder + backtester
node research/run.js research/data/snapshot.bsc.json

# Syntax-check everything
for f in research/*.js; do node --check "$f"; done
```

### What `--demo` shows

The demo builds a 3-pool synthetic snapshot with a deliberate ~2.75% triangular edge. The
path-finder finds the `BASE→A→B→BASE` cycle, the backtester sizes it (~4.5 base in → ~$36
net after gas, profitable for **both** executors), and the verdict is **KILL** — correctly —
because a single opportunity fails the representativeness gates (`< 5 ops/day`, daily net `<`
infra cost). That is the harness doing its job: an edge has to be *broad and repeatable*, not
just *present once*.

## Definite next steps (to turn the skeleton into a real prover)

1. **Stage 1 enumeration** — replay `PairCreated` logs per factory (gives creation block =
   freshness signal) or `allPairsLength()` + `allPairs(i)` backfill; batch `getReserves` via
   Multicall3; persist to Postgres/Parquet; **verify each fork's fee on-chain**.
2. **Stage 3 ground truth** — re-simulate each candidate path against **real historical state
   with revm/Anvil** to catch reverts, rounding, fee-on-transfer/honeypot tokens. This is the
   single most important fidelity upgrade; pure CPMM math lies.
3. **Gas constants** — replace the `gasModel.js` placeholders with measured numbers
   (`REPORT_GAS=true npx hardhat test` for `bofhV2`; a public Huff/Yul benchmark for the lean
   target).
4. **Live-shadow mode** — run the scanner for weeks signing **nothing**, log every would-be
   op, inspect the next block to see if a competitor took it / it would have reverted →
   measures the real **win-rate** and **revert rate** that the kill-criteria need.
5. **Token-safety layer** — **DONE (eth_call tier):** `tokenSafety.js` runs a **per-token
   `base->token->base`** buy-then-sell probe wired as a HARD pre-fire gate in the backtester (each
   non-base token checked independently; honeypot/sell-revert needs no baseline). **Remaining
   TODO:** an offline tax baseline for **interior** tokens (their real base<->token reserves, via
   a pool lookup), the exact **forked-EVM** buy-then-sell (`simulateOnFork` seam) to catch
   holder-state / `tx.origin` honeypots a stateless quote misses, plus temporal **fee-flip**
   detection (replay setter history).

## What this toolkit deliberately is NOT

- Not a live trading bot — it **signs nothing**.
- Not a contract change — `contracts/` and `test/` are untouched and stay unaudited until
  Stage 4 returns a real `GO`.
- Not a finished product — the honest TODOs above are where real data/work is required.
