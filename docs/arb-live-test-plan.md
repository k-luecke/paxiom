# Paxiom arb — capital deployment & live test plan

Drafted 2026-05-10 from analysis of `opportunities.log` (4,202 rows, 2026-03-17 → 2026-03-24)
and audit of `sdk/price-feeder.js`, `sdk/live-executor.js`, `PaxiomPool.sol`.

## Fee model (current state: solo)

Kyle is sole LP, sole user; arb engine is not yet a public service. **Real cost = gas only.**
The two fee constants in code are *not* current costs:

- `sdk/price-feeder.js:138` `FLASH_FEE = 0.0005` is the **Aave benchmark** (kept for comparison).
- `PaxiomPool.sol:18` `PROTOCOL_FEE_BPS = 9` is the **future customer rate** (no customers yet).

For current solo P&L: ignore both. For Tier D modeling (future external borrowers): use 0.09%.
For competitive analysis vs Aave: use 0.05%.

## The edge: cross-chain, not same-chain

Same-chain atomic flash arb (e.g. Base→Base) is a saturated market dominated by MEV
searchers with block-builder relationships, private mempools, and microsecond-latency
co-located infrastructure. A retail/cloud-hosted bot cannot outcompete them on speed
or gas-auction sophistication. **Don't compete there.**

Paxiom's edge is **cross-chain settlement that requires inventory on multiple chains**
— a position MEV searchers don't take because they optimize for in-block atomicity that
can't span chains. The opportunity exists *because* it cannot be made atomic. This is
the one path with structural moat for a non-co-located operator.

### Execution model — synthetic flash via pre-positioned inventory (cross-chain only)

Pre-position USDC + WETH on each chain in a pair; each cross-chain trade fires both legs
in parallel — each side already holds the asset it needs to deliver, so neither leg
"borrows" anything external. The inventory acts as the flash loan to itself.

- `sdk/live-executor.js:338-347` fires both legs via `Promise.all`
- Buy leg: USDC → WETH on `buyChain` via Uniswap V3 router (fee tier 500)
- Sell leg: WETH → USDC on `sellChain` via Uniswap V3 router (fee tier 500)
- **Slot in dataset:** 3,939 of 4,202 rows (the 41 base→base rows are out of scope —
  same-chain MEV will own those).
- Not atomic across chains. If one leg reverts you've shifted inventory in one direction
  only — manageable via the unwind script, not catastrophic.
- Round-trip pool fees: **0.10%** (Uniswap V3 fee tier 500 × 2 legs).

### Where PaxiomFlashLoan.sol fits

The flash-loan contract is **not on the own-arbing critical path**. It's the future
*Tier D* product surface: external borrowers (other arb bots) pay 0.09% to borrow from
PaxiomPool. We don't use it for our own trades because:

- We can't make cross-chain trades atomic anyway, so flash atomicity buys nothing
- Same-chain flash arb is the MEV-saturated market we're not entering
- Self-flashing same-chain would mean competing with MEV searchers we'd lose to

Keep the contract; ship the customer-facing service later when there's external demand.

**Implications for thresholds:** the breakeven must clear:
- `2 × 0.05% pool fee = 0.10%` (Uniswap charges both legs)
- Slippage at trade size (small at $1k, real at $50k+)
- Gas on two chains (~$0.50 total on L2s)

So **the true minimum capturable spread for any spot trade is ~0.20%**, not 0.05% / 0.10%.
The 0.05% / 0.035% in `price-feeder.js:144-152` filter logging-worthy spreads, not
profitable ones. Profitability gate is in `live-executor.js` via `quote.netProfit > 0`.

## Pre-flight fixes (do these BEFORE any live trade)

1. **Separate the fee constants by purpose.** Replace `FLASH_FEE` with three named values:
   `AAVE_BENCHMARK_FEE = 0.0005`, `PAXIOM_CUSTOMER_FEE = 0.0009`, `OWN_COST_FEE = 0`.
   Add a `MODE = 'solo' | 'customer' | 'aave-benchmark'` flag and select the cost at the
   break-even calc site. Default `MODE = 'solo'` until the engine is productized.
2. **Resize the quoter.** `sdk/price-feeder.js:25` and `sdk/live-executor.js:66` both use
   `TRADE_SIZE_USDC = 10_000000n` ($10). This makes `realSpreadPct` meaningless for capital
   sizing. Parameterize and quote at the same notional you'd actually deploy ($10k / $100k / $1M).
3. **Diagnose the `quoteFailed` rate.** Out of 4,202 logged rows, 0 had a successful
   real-quote. Run a one-shot diagnostic: hit `QUOTER_ADDRESSES.base` on mainnet directly
   with `TRADE_USDC = 10_000000n` (USDC→WETH, fee 500). If that succeeds, the production
   path works and prior failures were testnet-only. If it fails, the QUOTER_ADDRESSES
   constants are wrong, or USDC/WETH addresses are stale, or the 500-fee pool doesn't have
   liquidity. **Block live test until this returns a non-zero `wethOut`.**
4. **Add real `amountOutMinimum`.** Replace `amountOutMinimum: 0n` at
   [live-executor.js:269 and :332](../sdk/live-executor.js) with `quote.wethOut * 995n / 1000n`
   (buy leg) and `quote.usdcOut * 995n / 1000n` (sell leg). 0.5% on-chain slippage tolerance
   forces a revert if MEV moves the price more than expected.
5. **Add WETH-balance pre-check on sell-chain.** Currently
   [live-executor.js:253-262](../sdk/live-executor.js) only checks USDC on `buyChain`.
   Add a parallel check: WETH balance on `sellChain` ≥ `quote.wethOut`. Skip with
   `[SKIP] Insufficient WETH on <sellChain>` if not.
6. **Add a kill switch.** `KILL_FILE = '/tmp/paxiom-kill'` — top of the `executeLive`
   function and of the `poll` function, return early if `existsSync(KILL_FILE)`. Trivial
   to add and gives you a panic stop.

## Capital deployment tiers

The 7-day data implies four economically distinct tiers. The right answer is probably
**run Tier A → measure → expand**, not pick one upfront.

### Tier A — spot, $1k–$5k, threshold **0.20%**
- ~106 actionable opportunities/week (~15/day) at 0.20% gross spread
- Slippage at this size is < 0.01% (negligible) — mid-price ≈ executable price
- Pool fees: 0.10% round-trip (Uniswap V3 fee 500 × 2 legs)
- Per-trade economics: $1k × (0.20% − 0.10%) = $1.00 gross, − $0.50 gas = **$0.50 net**.
  Tight but positive; this is a *correctness* test, not a yield test.
- **Purpose: prove the execution path end-to-end with capital you can afford to lose.**
- Requires inventory on **both** sides of each chain pair (USDC + WETH).

### Tier B — spot, $50k–$100k, threshold **0.25–0.30%**
- ~68 actionable opportunities/week (~10/day) at 0.30%
- Slippage ~0.05% at this size into typical L2 pools — needs Tier-A-measured number
- Per-trade: $50k × (0.30% − 0.10%) = $100 gross, − slippage − $0.50 gas = ~$50–$80 net
- **Purpose: scale validated path. Requires Tier A to confirm execution works *and*
  measure real slippage to set this threshold honestly.**

### Tier C — own flash loan, $500k–$2M, threshold 0.30%
- ~30 actionable opportunities/day at 0.30% (extrapolating from 106 rows ≥ 0.20% / week)
- Slippage ~0.2% — large pool selection matters, may need to skip pools < $20M TVL
- Per-trade: $1M × 0.30% = $3,000 gross, − $0.20% × 2 = $1,000 net
- No fee cost in solo mode — the 0.09% is bookkeeping that returns to your own wallet via LP+protocol shares.
- **Purpose: scale-up using PaxiomPool. Requires Tier B + working PaxiomFlashLoan.sol on mainnet.**
- When external LPs join later, Tier C threshold should rise to ~0.40% to absorb the 0.063% LP-share cost.

### Tier D — fee revenue from external borrowers
- Independent of Tiers A–C. Other arb bots use PaxiomPool, you collect 30% of 0.09% = 0.027%
  on their volume regardless of trade outcome.
- **Purpose: monetize the untapped market hypothesis directly.**
- Marketing / SDK / docs problem, not an execution problem. Out of scope for live test;
  but Tiers A–C double as the public proof that the pool works.

## Recommended live test — staged, cross-chain only

**Overall goal:** validate that capturable cross-chain opportunities actually execute
profitably on mainnet at small size, and measure real (not simulated) slippage, fill
latency, and half-fill rate.

### Stage 1 — single chain pair, smallest viable size ($500 legs)
- **Pair: optimism↔base** (best risk-adjusted: 471 op→base rows in dataset, 0.146% mean
  spread; lower mean than base↔arbitrum but 3× the volume → faster sample size).
- $500 trade legs: clears 0.10% round-trip pool fees + ~$0.50 gas at ~0.30% gross spread,
  margin is thin but positive — this is a *correctness* test, not a yield test.
- Pre-position **$1,100 USDC + 0.2 WETH** on each of Optimism and Base
  (~$3,200 at-risk total). Same wallet on both chains.
- Threshold: `MIN_SPREAD = 0.30` (in `live-executor.js`).
- Run until 5 successful both-leg fills OR 24h, whichever first. Stop and review.

### Stage 2 — same pair, larger size ($2k–$5k legs)
- Once Stage 1 passes, scale size 4–10× on the *same* op↔base pair.
- Threshold can drop to 0.25% as size grows (more headroom over fixed gas).
- Pre-positioning expands proportionally: $11,000 USDC + 2 WETH per chain
  (~$32k at-risk total).
- Goal: confirm slippage scales as expected, hit-rate stays ≥80%.

### Stage 3 — add a second chain pair (parallel)
- Add **base↔arbitrum** (155 rows, 0.39% mean — highest mean P&L in dataset).
- Independent inventory and drift management per pair.
- Now running two pairs concurrently; the unwind monitor watches both.

### Setup (~2 hours)

1. Apply pre-flight fixes #1–#6 above. **The quoter diagnostic (#3) is the gate** — do not
   proceed to live trades until you can quote successfully on mainnet.
2. Set `MAINNET = true` in [sdk/live-executor.js:16](../sdk/live-executor.js).
3. Set `TRADE_USDC = 1000_000000n` ($1,000) in `live-executor.js:66`.
4. Set `MIN_SPREAD = 0.20` in `live-executor.js:9` (was `0.08`).
5. **Fund matrix** by stage. Each stage takes the previous stage's funded chains as a
   starting point — you're adding inventory, not replacing it.

   | stage | size | USDC base | WETH base | USDC op | WETH op | USDC arb | WETH arb | gas |
   |---|---|---|---|---|---|---|---|---|
   | 1 | $500 legs | $1,100 | 0.2 ETH | $1,100 | 0.2 ETH | — | — | 0.005 ETH each |
   | 2 | $2k–$5k legs | $11,000 | 2 ETH | $11,000 | 2 ETH | — | — | same |
   | 3 | + base↔arb | (same) | (+0.4 ETH) | — | — | $2,200 | 0.4 ETH | + 0.005 arb |

   2× USDC safety margin per side so a half-fill doesn't immediately block the next attempt.
6. Use a **fresh wallet** for this test. Don't reuse any wallet that has appeared in
   another context. Funding amount above is the maximum at-risk.
7. Use **paid RPCs** (Alchemy or Infura, one per chain). Free public RPCs rate-limit and
   add latency that kills the spread mid-trade.

### Run (24h)

1. Start `sdk/price-feeder.js` (scanner only, writes to `opportunities.log`).
2. Start `sdk/live-executor.js` (consumer + executor).
3. Tail `execution.log` and watch for the first fill.
4. **Stop after the first 3 successful round-trips** — don't run a full 24h on the first
   real attempt. Confirm receipts on chain explorers, reconcile USDC balances vs predicted
   net P&L, then resume.
5. After ~24h or 10 fills (whichever first), kill the executor and analyze.

### Measure

Compare every `execution.log` entry against its source `opportunities.log` row:
- **Slippage realized** = `predicted_spreadPct - realized_pnl_pct`
- **Fill latency** = `tx_mined_ts - opportunity_logged_ts`
- **Failure modes**: tx reverts, opportunity vanished mid-route, gas spike, RPC timeout

### Pass criteria (to graduate from Stage 1 → Stage 2)

- ≥80% both-leg fills (≥1 recoverable half-fill is acceptable IF the unwind script
  handled it cleanly)
- Zero un-recoverable half-fills
- Realized slippage ≤ 2× simulated quoter slippage (calibration check)
- Net P&L over the test ≥ 0 (just barely is fine — Stage 1 is about validation, not yield)
- Inventory drift < 30% start-to-end. Larger drift means one-direction-dominant flow →
  need asymmetric thresholds or out-of-band rebalance before Stage 2.

### Risks & mitigations

| risk | mitigation |
|---|---|
| **Half-fill (buy lands, sell reverts)** — leaves you holding WETH on wrong chain | `sdk/unwind.js` (sidecar) detects via missing receipt within 90s, classifies, logs, and (with `--auto-unwind`) can fire a same-chain corrective swap. Often the right play is wait-and-flatten via a reverse-direction trade rather than auto-unwind. |
| **Inventory drift** — one direction dominates flow, depleting one chain | Asymmetric threshold: raise `MIN_SPREAD` 50% on the depleted-direction route. Cron'd inventory check every 15min, alert if any side < 30% of starting balance. |
| **Sandwich/MEV** — `amountOutMinimum: 0n` lets attacker frontrun | Pre-flight fix #4 sets a real 0.5% on-chain min |
| **Stale quote** — price moves between quote and tx | Pre-flight: reject if `Date.now() - opp.timestamp > 5000ms` (add to `executeLive` early-exit) |
| Mainnet RPC rate-limit / latency | Paid RPC per chain (pre-flight fix #7-implied) |
| Tx reverts after gas paid | $0.50–$2 / revert acceptable at $1k size |
| Wallet key compromise | Fresh wallet, only test funds |
| **MEV cross-chain front-run** | Theoretically possible but the multi-chain inventory requirement keeps the pool of attackers small. Real `amountOutMinimum` (pre-flight fix #4) bounds worst-case loss per leg to slippage tolerance. |

## Out of scope for this test

- wstETH (mean spread 0.041% is below realistic post-slippage threshold; revisit at Tier B).
- External-LP / Tier D customer economics — measure Paxiom's own performance first.
- Bridges. The inventory model deliberately avoids bridges in the trade path; rebalancing
  inventory between chains (when drift becomes large) uses native bridges out-of-band.
- optimism→arbitrum (highest volume, 1,965 rows) — thin spread (0.049% mean), most rows
  fall below the 0.20% threshold once pool fees + slippage are honest. Defer to Tier B/C.
