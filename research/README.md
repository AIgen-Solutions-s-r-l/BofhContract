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
| 2 Path-finder | `pathfinder.js` | Build the token graph, run Bellman-Ford **negative-cycle** detection seeded at baseToken to surface round-trip candidates (2–5 hops). **Pure function over a snapshot** → testable offline. | Real, working candidate generator. Exhaustive enumeration (Johnson / line-graph MMBF) is a noted upgrade. |
| 3 Sizing + net-of-gas | `backtester.js` | Size each cycle to its optimal input, simulate CPMM output, subtract per-hop fees **and** gas+priority fee priced for **both** the fat and lean executors. | Real CPMM math. **revm/Anvil re-simulation against historical state is TODO** (without it, pure formulas overstate profit). |
| 4 Paper-trade + KILL/GO | `backtester.js` | Apply explicit kill-criteria, emit the verdict + stats. | Real. Win-rate/revert come from config until live-shadow + revm provide measured values. |
| — Gas model | `gasModel.js` | Documented per-hop gas constants for **this** executor vs a **lean** target so the strip decision is data-driven. | Constants are **PLACEHOLDERS** — replace with measured `REPORT_GAS` numbers. |
| — Config | `config.js` | Loads config, resolves RPC from **env vars only**, reuses `scripts/utils/addresses.js` for base tokens/factories, warns on address drift. | Real. |
| — Runner | `run.js` | Offline orchestrator: runs Stage 2→4 over an existing/`--demo` snapshot with zero RPC. | Real. |

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

## Run each stage

```bash
# Offline smoke test (no RPC needed): runs path-finder + backtester over a synthetic snapshot
node research/run.js --demo

# Stage 1: scan configured chains -> writes research/data/snapshot.<chain>.json
#   (needs RPC env vars + "seedPairs" in config until full enumeration is implemented)
node research/scanner.js

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
5. **Token-safety layer** — `eth_call` revert-guard + honeypot/transfer-tax heuristics before
   any path is counted profitable (long-tail pools are full of unsellable tokens).

## What this toolkit deliberately is NOT

- Not a live trading bot — it **signs nothing**.
- Not a contract change — `contracts/` and `test/` are untouched and stay unaudited until
  Stage 4 returns a real `GO`.
- Not a finished product — the honest TODOs above are where real data/work is required.
