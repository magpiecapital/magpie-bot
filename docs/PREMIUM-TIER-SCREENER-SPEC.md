# Premium-tier eligibility screener — spec

Companion to `MGP-002` in magpiecapital/magpie-site. Defines the runtime gate that every Premium-tier borrow must pass on the bot side **before** the authority signs the v3 `request_and_fund_loan` instruction.

**Status:** spec + draft module (`src/services/premium-tier-screener.js`). NOT wired into the borrow path. Activation gated on MGP-002 + MGP-003 + MGP-004 + the v3 deploy.

---

## 1. Why this exists in the bot, not on-chain

The Anchor program (v3) enforces structural correctness — math, signer checks, PDA derivation, the on-chain TWAP gate. It does **not** know about:

- Token categories (memecoin vs stock)
- DEX volume floors
- Per-pool / per-tier collateral whitelists
- Liquidation-solvability simulation
- Per-borrower credit history

All of those are off-chain registry state. The bot is the authority co-signer on every borrow. Refusing to sign is the enforcement mechanism. Same model as the existing post-2026-06-07 anti-exploit gauntlet — that's also off-chain, gated by the bot's signature.

If the bot's signing logic is ever bypassed (e.g. an admin endpoint that signs arbitrary borrow accounts), the gate fails open. Keep the signer logic behind a single chokepoint.

---

## 2. Module location

`src/services/premium-tier-screener.js` — new sibling of `anti-exploit.js`, `loan-limits.js`, `token-screener.js`.

Public API:

```js
import { screenPremiumBorrow } from "./premium-tier-screener.js";

const result = await screenPremiumBorrow({
  collateralMint,        // string — base58 pubkey
  proposedLoanLamports,  // bigint
  borrowerPubkey,        // string — base58
  pool,                  // "v1" | "v3-premium"
  now,                   // optional — Unix seconds; defaults to current
});

// result shape — same as anti-exploit.js for consistency
//   { blocked: false, reason: "ok" }                        — proceed
//   { blocked: true,  reason: "...", message: "..." }       — refuse
```

The borrow flow calls `screenPremiumBorrow()` immediately after `anti-exploit.js` for Premium-tier (`pool === "v3-premium"`) borrows. Existing-tier borrows skip this entirely; they keep the v1 path.

---

## 3. Gates, in execution order

Run cheapest first; refuse on first failure.

### Gate 1 — Category gate (DB, <5ms)

```sql
SELECT enabled, protected, category
  FROM supported_mints WHERE mint = $1
```

**Refuse if:** `category != 'stock'` OR `enabled = false` OR `protected = false`.

Message: `"This token isn't eligible for Premium-tier borrowing. Premium tier is restricted to tokenized stocks; use a different tier for non-stock collateral."`

### Gate 2 — Premium whitelist gate (DB, <5ms)

```sql
SELECT mint, max_open_lamports
  FROM premium_tier_whitelist
  WHERE mint = $1 AND enabled = true
```

Schema (new table):

```sql
CREATE TABLE premium_tier_whitelist (
  mint                 TEXT PRIMARY KEY REFERENCES supported_mints(mint),
  enabled              BOOLEAN NOT NULL DEFAULT TRUE,
  max_open_lamports    BIGINT NOT NULL,    -- per-token aggregate cap
  added_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by             TEXT NOT NULL,      -- operator pubkey or "MGP-XXX"
  notes                TEXT
);
CREATE INDEX premium_tier_whitelist_enabled_idx
  ON premium_tier_whitelist (enabled) WHERE enabled = TRUE;
```

**Refuse if:** mint not on whitelist.

Message: `"This stock isn't yet on the Premium-tier whitelist. The operator adds stocks via MGP-style governance proposals (see magpie.capital/governance). For now, use a shorter-tier loan."`

Initial whitelist content is set by the operator with a one-shot script `scripts/seed-premium-whitelist.js` (write alongside the deploy).

### Gate 3 — Institutional price feed gate (RPC + Pyth/Switchboard SDK, 100-300ms)

```js
const feedHealth = await fetchOracleFeedHealth(collateralMint);
// returns { source, price_usd, slot, age_seconds, confidence_bps, status }
```

**Refuse if:** `feedHealth.status !== 'live'` OR `feedHealth.age_seconds > 60` OR `feedHealth.confidence_bps > 250`.

Message: `"The price feed for this stock is currently degraded — won't borrow against it until the feed recovers. Try again in a few minutes."`

Implementation note: Pyth and Switchboard both publish health-of-feed metadata. Use Pyth's `priceComponent.aggregate.confidence` and `priceComponent.lastSlot` for liveness. Cache feed health 10s per mint to avoid hammering the oracle.

### Gate 4 — 24h volume floor (DexScreener cache, <5ms after warm)

Cached in `mint_market_metadata` (existing table). Refreshed by the existing screener pipeline; we just read.

**Refuse if:** `volume_24h_usd < PREMIUM_TIER_MIN_VOLUME_USD` (env, default $250K).

Message: `"This stock's 24h volume is below the Premium-tier floor. Premium tier requires deep on-chain liquidity to safely support 30-day borrows."`

### Gate 5 — Liquidation-solvability simulation (compute, 50-150ms)

```js
const sim = simulateLiquidation({
  collateralMint,
  collateralAmount,  // implied by loan size at LTV
  currentDepthUsd: pair.liquidity.usd,
  worstCaseSlipBps: 1000,  // 10% slip assumed
});
// returns { solvable: bool, unwind_seconds_estimate, max_safe_collateral }
```

**Refuse if:** `!sim.solvable` OR `sim.unwind_seconds_estimate > PREMIUM_TIER_MAX_UNWIND_SECONDS` (env, default 3600 / 1h).

Message: `"At your borrow size, the protocol's liquidation simulator can't guarantee unwind within 1 hour at current on-chain depth. Try a smaller loan, or wait for deeper liquidity."`

Implementation: `simulateLiquidation()` reads the live DexScreener pair liquidity, divides collateral by liquidity to estimate unwind, applies a worst-case slippage. Same formula the off-chain liquidation bot uses.

### Gate 6 — Per-borrower credit gate (DB, <5ms)

```sql
SELECT
  COUNT(*) FILTER (WHERE status = 'liquidated' AND start_timestamp > NOW() - INTERVAL '90 days') AS recent_liquidations,
  COUNT(*) FILTER (WHERE status = 'repaid')      AS lifetime_repaid,
  COUNT(*) FILTER (WHERE status = 'liquidated')  AS lifetime_liquidated
FROM loans
WHERE borrower_wallet = $1
```

**Refuse if:**
- `recent_liquidations > 0` (any liquidation in the last 90 days), OR
- For first-time Premium-tier borrowers: `lifetime_repaid < 3` (need at least 3 successful repayments on existing tiers first).

Message: `"Premium tier requires a clean repayment history. Build 3+ successful repays on the existing tiers (Express/Quick/Standard) first, and no recent liquidations."`

### Gate 7 — Per-token aggregate cap (DB, <5ms)

```sql
SELECT COALESCE(SUM(original_loan_amount_lamports), 0)::TEXT AS open_lamports
FROM loans
WHERE collateral_mint = $1
  AND status = 'active'
  AND pool = 'v3-premium'
```

**Refuse if:** `currently_open + proposedLoanLamports > whitelist.max_open_lamports`.

Message: `"This stock has reached the Premium-tier aggregate exposure cap (${openSol} of ${capSol} SOL already lent). New Premium-tier loans pause against this mint until existing loans repay or roll off."`

### Gate 8 — Per-loan absolute cap (env, instant)

**Refuse if:** `proposedLoanLamports > PREMIUM_TIER_MAX_LOAN_LAMPORTS` (env, default 10 SOL = 10_000_000_000).

Message: `"Premium-tier loans are capped at 10 SOL per loan in v0. The cap will be raised as the tier matures and the operator has more liquidation data."`

---

## 4. Observability

Emit a structured log on every screener decision:

```js
console.log(JSON.stringify({
  event: "premium_screen",
  ts: new Date().toISOString(),
  collateralMint,
  borrower: borrowerPubkey,
  proposed_loan_sol: Number(proposedLoanLamports) / 1e9,
  result: result.blocked ? `refused:${result.reason}` : "ok",
  gate_durations_ms: gateTimes,  // per-gate timing for SLO monitoring
}));
```

Add a dashboard panel to `/admin` (operator-only) that shows:
- Premium screen attempts per hour
- Refusal rate by reason
- Median gate latency

These signals tell us where the gate is too tight or too loose.

---

## 5. Test coverage requirements

Before activation, the module must have:

- Unit tests for each gate's pass/fail boundary
- Property test: no input ever causes an unhandled exception (no `throw` escapes the screener)
- Integration test against a local Postgres + a mocked Pyth feed + a mocked DexScreener pair
- Deterministic-fixture test reproducing the June 7 $FATHER oracle-manipulation scenario — confirms the screener would have refused (it would: $FATHER fails gate 1 immediately because it's a memecoin, not a stock; and now also fails gate 2 because it's disabled).

---

## 6. Activation runbook

**Do not flip activation without all of these checked:**

1. ✅ MGP-002 has closed with Q1 passing
2. ✅ MGP-003 (Tier C escalation) has closed with PASS
3. ✅ MGP-004 (Tier A binding) has closed with PASS
4. ✅ `magpie-lending-v3` deployed at a real program ID (placeholder `declare_id!` replaced)
5. ✅ Premium pool initialized (`initialize_pool` called against v3 with the operator's Premium fee wallet)
6. ✅ `premium_tier_whitelist` table created + seeded with the operator-approved tokens (5–10 to start)
7. ✅ `screenPremiumBorrow()` import added to the borrow flow with `pool === "v3-premium"` branch
8. ✅ Bot's authority-signer refuses to sign v3 borrow txs where the screener result is `blocked`
9. ✅ Test coverage above is at 100% on the gates
10. ✅ Site UI gated behind a feature flag — Premium tier card appears only when `PREMIUM_TIER_ENABLED=true`
11. ✅ Public-facing copy on `/tiers`, `/docs`, `/whitepaper`, `/api/v1/info`, and Pip's prompts updated to reflect the new tier

Then, and only then, flip `PREMIUM_TIER_ENABLED=true` in production.

**Rollback plan:** flip the flag off. The on-chain v3 program keeps existing Premium loans alive through their natural lifecycle; the bot just stops origina­ting new ones. No code change needed.

---

## 7. What's NOT in this spec

- **The MGP-004 binding proposal text** — that's a separate proposal that depends on what Q1 + Q3 + Q4 indicate.
- **The v3 program code changes** — fee-wallet-owner constraint, 4-tier expansion, on-chain Premium gate. Tracked separately in a v3 PR.
- **The Premium pool's separate-vault design** — separate pool init, LP migration UI, separate-pool risk dashboards. Tracked in MGP-004 + the deploy runbook.
- **Whitelist governance** — adding/removing stocks from the Premium whitelist after launch. Likely Tier A1 collateral votes scoped to Premium-tier.

Related: [MGP-002](https://github.com/magpiecapital/magpie-site/blob/main/proposals/MGP-002-extended-duration-tier-signal-poll.md), the Anchor v1 audit findings in `SECURITY-AUDIT-ANCHOR-2026-06-09.md` (Finding 1 — fee-wallet-owner — should be fixed in v3 alongside the tier expansion).
