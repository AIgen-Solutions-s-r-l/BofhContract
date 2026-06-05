# CoW Protocol solver — BofhContractV2 filler (SCAFFOLD)

> Status: **runnable skeleton, not a money printer.** This directory wires the existing
> BofhContractV2 + off-chain research toolkit into the shape of a CoW Protocol *solver*. It
> proves the *plumbing*, not an *edge*. Earning rewards is gated on (a) passing CoW's KYC, (b)
> a Gate-0-style live validation that the opportunity actually exists net-of-everything, and
> (c) a contract change to handle generic fills (see "Known limits" below). Read this whole
> file before doing anything with real keys or bonds.

---

## 1. What a CoW solver is (and where Bofh fits)

CoW Protocol runs a **batch auction**. Users sign orders (gasless, off-chain). A **solver
competition** then finds the settlement that gives users the most surplus. Two components:

- **Driver** — CoW infrastructure. For bonding-pool members it is *managed by the CoW team*.
  It fetches liquidity, generates on-chain submission keys, runs EBBO fairness checks, can
  merge disjoint solutions, picks the winner, and submits the settlement tx. **We do not build
  this.**
- **Solver engine** — *our* HTTP service. The driver `POST`s a batch auction to
  `{base_url}/${env}/${network}/solve`; we return `{ "solutions": [...] }`. That transform is
  what `solve.js` implements.

**The reuse, stated plainly:**

| Role in a CoW solver        | This repo's asset                                   |
|-----------------------------|-----------------------------------------------------|
| **Interaction contract**    | `BofhContractV2` — the non-custodial executor the CoW `GPv2Settlement` calls via a custom interaction. It pulls the sell/base token from Settlement and returns the bought token *in the same tx*. |
| **Solution engine**         | `research/pathfinder.js` (Bellman-Ford negative-cycle finder over the V2-fork registry). |
| **Solution scorer**         | `research/backtester.js` + `gasModel.js` — net-of-gas USD; we only emit a solution with strictly positive net surplus. |
| **Token-safety gate**       | `config.tokenAllowlist` (fail-closed). This is the off-chain analogue of the report's token-safety simulator — until that simulator exists, the allowlist is the only thing standing between you and a honeypot/fee-on-transfer token. |

`BofhContractV2` is the **commodity settlement leg** the deep-research report described. The CoW
*solver role* is one of the two places the report said the value actually lives (the other being
sealed-bid on-chain backrun auctions). This scaffold is the on-ramp to that role.

---

## 2. Economics (verify before trusting any number)

CoW solver rewards come from two pools, both paid in **COW** (rewards address must be controlled
by your team **on both the solving chain and on mainnet**).

**Performance rewards** — confirmed from the rewards reference doc:
```
performanceReward_i = cap( totalScore − referenceScore_i − missingScore_i )
```
The `cap` is per-chain. For **Ethereum / Arbitrum / Base**: `β = 50%`, `cap floor cl = 0.010 ETH`.
Gnosis/Polygon/Plasma use `β = 100%` with native-token floors; Avalanche/BNB/Linea/Ink likewise.
Net: your reward per batch is bounded — you cannot win an unbounded amount on one batch, and you
are scored *relative to the next-best solver* (`referenceScore`). Being the only solver on a
long-tail batch is where the marginal reward concentrates.

**Consistency rewards** — a separate budget split *proportional to the number of executed orders
you submitted a solution for*. Rewards turning up requires **showing up consistently**, not just
occasionally sniping.

**Quote/price-estimation competition** — optional separate program; quote rewards range from
`min{0.00003 ETH, 6 COW}` to `min{0.0007 ETH, 6 COW}` per chain.

**Bonding-pool service fee** — confirmed: members of a managed bonding pool pay **15% of weekly
COW rewards** as a service fee, **beginning ~6 months after joining**.

> ⚠️ **Figures I could NOT confirm against the live docs (2026-06):** the **"CIP-85 long-tail
> rewards"** label and the **"~25% bond"** number from the project brief did **not** appear in
> the rewards reference page I fetched. The bond is real in spirit — you must keep a native-token
> balance on your submission address (see runbook) and a bonding pool backs your solver's
> penalties — but treat the *exact* "25%" and the *exact* "CIP-85" mechanism as **TODO: re-verify
> against the current CIP index** before quoting them to anyone or sizing a bond. Do not put real
> money behind an unverified percentage.

**Bottom line:** rewards are capped-per-batch, relative-to-competition, paid in a volatile token
(COW), reduced by a 15% pool fee after 6 months, and require *consistent* participation. The edge
has to survive all of that *and* gas. Prove it on real data first.

---

## 3. Real onboarding runbook (in order — do NOT skip)

From CoW's solver onboarding doc. **Arbitrum is required first**; mainnet comes only after an L2
track record.

| Stage | Network | Native balance to keep | What happens |
|-------|---------|------------------------|--------------|
| 0. Local dev | — | — | Build the engine locally; replay auctions. |
| 1. **Shadow** | Arbitrum + mainnet | none (no settlement) | Driver feeds you *production* auctions; your solutions are scored but **never settled on-chain**. This is the free, no-risk edge-proof. **Stay here until shadow shows real, repeatable net-positive solutions.** |
| 2. **KYC** | — | — | Submit incorporation details + shareholder list + **1–2 passports of main shareholders/devs**; name your solver in the email. Takes **1–3 working days**. |
| 3. **Staging (Barn)** | **Arbitrum** | **~0.05 ETH** | Live on-chain settlement, low volume. |
| 4. **Production** | **Arbitrum** | **~0.2 ETH** | Full orderflow competition. |
| (later) Mainnet | mainnet | staging 0.2 ETH / prod 1 ETH | Only after Arbitrum track record. |

Other chains' balances for reference: Base 0.05/0.2 ETH (staging/prod); Gnosis 15/100 xDAI.

**Engine endpoint format the driver expects:** `{base_url}/${env}/${network}`
e.g. `https://api.your-solver.io/staging/arbitrum-one` → it `POST`s `/solve` there.
Networks string set includes `arbitrum-one, base, bnb, mainnet, xdai, optimism, polygon, sepolia, …`.

**Gate-0 (CRITICAL, do this before staging/bonding):** the research report flagged that Chainlink
**acquired Atlas (22 Jan 2026)** and pivoted toward SVR-liquidation flow. CoW is a *different* OFA,
but the same risk applies: **confirm the permissionless solver competition is still open to new,
KYC'd-but-independent solvers on Arbitrum, and that long-tail DEX-backrun orderflow still reaches
solvers,** *before* you spend on KYC/bond. If the orderflow has been captured by privileged
solvers or routed elsewhere, the whole play is dead on arrival. **Verify live; do not assume.**

---

## 4. Files

| File | What it is |
|------|------------|
| `solve.js` | The solver engine `solve(auction) -> { solutions }` transform + a `--demo` harness. Parses a CoW batch auction, gates orders through the allowlist, routes via the pathfinder, scores net-of-gas, builds the CoW solution JSON. |
| `settlement.js` | Encodes a routed path into `BofhContractV2.executeSwapMultiDex(...)` calldata and wraps it as CoW `custom` interaction tuple(s) (approve + swap), with `inputs/outputs/allowances`. |
| `config.example.json` | Chain (Arbitrum), CoW endpoints (via **env vars**, never inline secrets), interaction-contract address, mirrored DexRegistry, and the token allowlist. |

### Run the skeleton (no RPC, no keys)
```bash
node --check solvers/cow/solve.js
node --check solvers/cow/settlement.js
node solvers/cow/solve.js --demo
```
The `--demo` path reuses `research/run.js`'s synthetic snapshot so the cycle finder yields a route
and you can see a real CoW-shaped solution come out. `0 solutions` is *also* a valid outcome
(the net-of-gas gate is doing its job).

---

## 5. Known limits & honest TODOs (read before believing this works)

1. **V2-only liquidity limit (structural).** `BofhContractV2` routes solely over Uniswap-V2-fork
   pools in its owned `DexRegistry`. CoW batches clear against the *whole* market — Uni-V3, Curve,
   Balancer, native CoW-AMM, plus other solvers' liquidity. A V2-only solver will **lose most
   competitive batches** to solvers with full-market liquidity. The realistic niche is **long-tail
   / fresh V2-fork pools** where V3-class liquidity is thin — exactly the report's thesis, and a
   small slice of total flow.
2. **The contract is an arb executor, not a generic A→B router (blocking).**
   `executeSwapMultiDex` requires `path[0] == path[last] == baseToken` and pulls `baseToken` from
   `msg.sender`. So today it can only settle a **baseToken-in / baseToken-out** leg (i.e. an
   arbitrage/backrun cycle surfaced inside the batch), **not** an arbitrary user fill
   (sell USDC → buy PEPE). `routeOrder` honestly **returns null and skips** any non-baseToken
   order rather than mis-encoding one. Generic fills need a **contract change** (a `swapExactIn`
   entrypoint that takes `(tokenIn, tokenOut, amountIn, minOut, path...)` and pays the recipient).
   **TODO + flagged loudly** in `settlement.js`.
   Path-length constraint: the contract's `MAX_PATH_LENGTH` is **6** (6 tokens), and a route's
   **hop count = path.length − 1**, so any settlable route is **≤ 5 hops** (≤ 6 tokens). Set
   `config.pathfinder.maxHops ≤ 5` accordingly. (Earlier drafts of this README/config said
   `MAX_PATH_LENGTH (5)` — that was wrong; it is 6 tokens / 5 hops.)
3. **KYC = permanent loss of anonymity.** Onboarding requires **passports of the main
   shareholders/devs** and full incorporation/shareholder disclosure to a third party. This is
   irreversible. For a searcher operation that has so far been pseudonymous, this is the single
   biggest non-technical cost. Decide *before* shadow whether you are willing to be doxxed to CoW.
4. **No real driver / HTTP server.** `solve.js` is the pure transform only. A production engine
   needs an HTTP server (express/fastify — **not installed; do not add deps without sign-off**)
   bound at `{env}/{network}/solve`, plus the driver auth secret from onboarding. **TODO(real).**
5. **No live reserves.** Routing needs a pool snapshot. `scanner.js` produces it but needs RPC; the
   `--demo` path uses a synthetic snapshot. A real run must feed a fresh, block-current snapshot
   (stale reserves → reverts → wasted gas + reputation hit). **TODO(real).**
6. **Token-safety is an allowlist, not a simulator.** The fee-on-transfer / honeypot / rebasing
   protection here is *only* `config.tokenAllowlist` (fail-closed). The report's actual
   token-safety *simulator* is **not implemented**. Do **not** widen the allowlist to long-tail
   tokens until that simulator exists and each token passes it.
7. **Gas + reward numbers are placeholders.** `gasModel.js` constants are conservative guesses;
   the COW reward figures move with the token price; the bond percentage is unverified (§2). Net
   surplus shown is *indicative*, not *bankable*.
8. **Prove → strip → audit (discipline).** Per the research mandate: prove the edge in **shadow**
   on real auctions *first*; only then consider whether the fat `BofhContractV2` should be stripped
   to a lean executor (its gas may erase the long-tail edge — that's the whole point of the
   fat-vs-lean comparison in `backtester.js`); audit **last**, before any production bond.
9. **Integration risk: `antiMEV` rate-limits a repeatedly-firing solver.**
   `BofhContractV2.executeSwapMultiDex` (our interaction entrypoint) carries the **`antiMEV`**
   modifier, which — *when enabled* — enforces a **per-block transaction cap** (`maxTxPerBlock`,
   default 3) **and a `minTxDelay`** (default 12s) **per calling address**. A CoW solver wins
   batches back-to-back and the settlement calls our contract from the **same `GPv2Settlement`
   address** every time, so an enabled `antiMEV` would **revert** the second-or-later settlement
   in a window — silently turning wins into failed settlements (wasted gas + a reputation/penalty
   hit). `mevProtectionEnabled` is a `bool` with **no initializer, so it is OFF by default**, but
   this is an **operational contract**: whoever owns the deployed interaction contract **MUST keep
   `antiMEV` disabled, or size `maxTxPerBlock`/`minTxDelay` to the solver's win cadence** (e.g. via
   `configureMEVProtection`). Treat this as a deploy-time checklist item — verify
   `getMEVProtectionConfig()` before any staging/prod run. (This anti-MEV guard makes sense for the
   contract's standalone arb use, but is actively hostile to its use as a high-frequency CoW
   interaction contract.)

---

*This scaffold deliberately makes it easy to say "no". If shadow mode doesn't show a repeatable,
net-of-gas-positive, V2-reachable edge, the correct outcome is to stop here — before KYC, before a
bond, before an audit.*
