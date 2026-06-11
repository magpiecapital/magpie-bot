# Premium-tier deploy plan — 2026-06-09

Operator decision: ship the Premium tier with **both 15-day and 30-day duration options**, restricted to tokenized stocks, under Tier B operator discretion. MGP-002 (the signal poll) was withdrawn 2026-06-09 once the decision was made.

This document is the plan-of-attack — what's shipping, the order, the code diffs, the runbook, the rollback plan, and the monitoring posture. Companion to:

- [`PREMIUM-TIER-SCREENER-SPEC.md`](./PREMIUM-TIER-SCREENER-SPEC.md) — the off-chain eligibility gate
- [`V3-DEPLOY-READINESS-2026-06-09.md`](./V3-DEPLOY-READINESS-2026-06-09.md) — the v3 program audit
- [`SECURITY-AUDIT-ANCHOR-2026-06-09.md`](./SECURITY-AUDIT-ANCHOR-2026-06-09.md) — v1 audit findings; Finding 1 (fee-wallet-owner) gets folded into v3 during this deploy

---

## 0. Executive summary

**What's shipping:** two new loan tiers, both restricted to tokenized stocks on an explicit whitelist, gated by an 8-step runtime screener.

| Tier | Term | LTV cap | Upfront fee | Eligible collateral |
|---|---:|---:|---:|---|
| Premium-15 | 15 days | 45% | 3.5% | Tokenized stocks on Premium whitelist |
| Premium-30 | 30 days | 40% | 5.0% | Tokenized stocks on Premium whitelist |

**Pool structure:** separate liquidity pool for Premium tiers. v3 program, fresh `initialize_pool` call, own vault, own LP positions. v1 pool unaffected. Existing v1 loans continue under v1 program ID; existing v1 LPs continue earning v1 fee shares.

**Why this design:**
- **Two collateral tracks at launch:**
  - **Equity track** — tokenized stocks (NVDAx, COINx, TSLAx, AAPLx, MSFTx). Institutional Pyth feeds, low volatility, full Premium parameters (45% LTV @ 15d, 40% LTV @ 30d).
  - **Blue-chip Solana memecoin track** — top-tier memecoins ($PUMP, $BONK, $FARTCOIN, $TROLL). More conservative parameters (35% LTV @ 15d, 30% LTV @ 30d) to absorb higher volatility, plus tighter screener thresholds ($500K 24h volume floor vs $250K for equities, max-unwind ceiling 30 min vs 60 min). No long-tail / random pump.fun graduates — only protocol-recognized blue-chips.
  - Memecoin expansion beyond these four is a follow-up after 90 days of Premium operating data — both tracks evaluated independently.
- **Two duration options, different parameters per duration** because the risk profile changes with time-at-risk: shorter duration tolerates a more aggressive LTV; longer duration needs lower LTV plus a higher fee to compensate for added duration risk.
- **Separate pool** because Premium-tier liquidation cascades should not eat existing LP yield. Premium LPs opt in to a different risk profile and earn Premium-only fees.
- **Tier B operator discretion not Tier A vote** because (a) MGP-002 was withdrawn in favor of executive decision, (b) loan-duration changes are explicitly Tier B in v0 GOVERNANCE.md, (c) a future MGP-NNN can move loan-duration into Tier A via Tier C escalation if the community wants that authority back. Operator's choice not to escalate is within scope.

**Timeline:** 4–6 weeks from go-ahead to first Premium loan. Detailed step-by-step runbook in §11.

**Reversible:** the on-chain v3 program is permanent, but the bot's Premium-tier routing is gated by `PREMIUM_TIER_ENABLED` env. Flipping to `false` stops new Premium borrows immediately; existing Premium loans continue under v3 through their natural lifecycle.

---

## 1. Final tier parameters

Two collateral tracks share the Premium-15 / Premium-30 duration structure but apply different LTV + fee parameters and screener thresholds based on the volatility class.

### 1a. Equity track (tokenized stocks)

| Parameter | Premium-15-EQ | Premium-30-EQ | Notes |
|---|---|---|---|
| **Term** | 15 days | 30 days | Hard-coded in v3 `TIER_DURATION_DAYS` |
| **LTV cap** | 45% | 40% | Hard-coded in v3 `TIER_LTV_BPS` |
| **Upfront fee** | 3.5% | 5.0% | Hard-coded in v3 `TIER_FEE_BPS` |
| **Per-loan cap (launch)** | 10 SOL | 10 SOL | Env: `PREMIUM_TIER_MAX_LOAN_LAMPORTS` |
| **Per-token aggregate cap (launch)** | 10 SOL | 10 SOL | `premium_tier_whitelist.max_open_lamports` |
| **Eligible collateral** | Tokenized stocks on the Equity whitelist | Same | Screener Gate 1 (category=stock) + Gate 2 (whitelist) |
| **24h volume floor** | $250K | Same | Screener Gate 4 |
| **Max liquidation unwind** | ≤ 60 min | Same | Screener Gate 5 |
| **Eligible borrowers** | 3+ clean repays, no liquidations in 90d | Same | Screener Gate 6 |

### 1b. Blue-chip Solana memecoin track

Only the top-tier Solana memecoins with verified depth, multiple oracle sources, and established holder distribution. No long-tail / random pump.fun graduates — this whitelist is intentionally narrow.

| Parameter | Premium-15-BC | Premium-30-BC | Notes |
|---|---|---|---|
| **Term** | 15 days | 30 days | Same on-chain duration constants |
| **LTV cap** | 35% | 30% | More conservative than equity — absorbs higher volatility |
| **Upfront fee** | 4.5% | 6.5% | Higher fee compensates for higher volatility risk |
| **Per-loan cap (launch)** | 5 SOL | 5 SOL | Half of equity cap — tighter blast radius while gathering data |
| **Per-token aggregate cap (launch)** | 5 SOL | 5 SOL | Same — keep per-token concentration low at launch |
| **Eligible collateral** | Blue-chip Solana memecoins on whitelist | Same | Screener Gate 1 (category=memecoin) + Gate 2 (blue-chip whitelist) |
| **24h volume floor** | **$500K** | Same | Tighter than equity's $250K — memecoin liquidity dries up faster |
| **Max liquidation unwind** | **≤ 30 min** | Same | Tighter than equity's 60 min — memecoin price-discovery cliffs are faster |
| **Eligible borrowers** | 5+ clean repays, no liquidations in 90d, no Trusted-tier loans currently active over 5 SOL | Same | Stricter than equity — need more history before betting on memecoin volatility |

### Shared parameters (both tracks)

- **Liquidation gauntlet:** existing TWAP + cross-source + post-borrow watcher + v3's on-chain TWAP. No new defenses; layered application.
- **Liquidation reward:** same `keeper_reward_bps` as v1. No change to liquidator economics.
- **Fee split (Premium pool):** per MGP-001 outcome (70% holders / 10% Premium-LPs / 10% referrer / 10% protocol reserve if it passes; otherwise current 80/10/5/2/3). Premium LPs earn pro-rata to their Premium-pool deposit share. Both tracks deposit into the same Premium pool — separate-from-v1 risk isolation is at the v1/v3 boundary, not at the track boundary.
- **Allowed borrower wallet states:** per existing bot gates (anti-exploit gauntlet still applies). No relaxation.

Why 45% LTV on 15-day vs 40% on 30-day: shorter time-at-risk allows a more aggressive LTV at the same expected liquidation rate. Empirical traditional-margin parallel: brokerages allow higher initial margin on shorter holding periods.

Why 3.5% on 15-day vs 5% on 30-day: time premium. Annualized: 3.5% × (365/15) ≈ 85% vs 5% × (365/30) ≈ 61%. Premium-15 is more expensive on an annualized basis because the protocol's gate-evaluation cost is mostly fixed per loan; shorter loans amortize less of that.

---

## 2. v3 program changes

Five contained edits in `programs/magpie-lending-v3/src/lib.rs`, ~80 LoC. All folded into a single PR titled `v3: premium tier — 15d + 30d tokenized stocks`.

### Change 1 — Expand tier tables

```rust
// Express(0), Quick(1), Standard(2), Premium-15(3), Premium-30(4)
const TIER_LTV_BPS:        [u64; 5] = [3_000, 2_500, 2_000, 4_500, 4_000];
const TIER_DURATION_DAYS:  [i64; 5] = [    2,     3,     7,    15,    30];
const TIER_FEE_BPS:        [u64; 5] = [  300,   200,   150,   350,   500];
```

Update `request_and_fund_loan` validation:

```rust
require!(loan_option <= 4, ErrorCode::InvalidLoanOption);
```

Update `extend_loan` tier resolution to include the Premium tiers:

```rust
let tier = match loan.ltv_bps {
    3_000 => 0usize, // Express
    2_500 => 1,      // Quick
    2_000 => 2,      // Standard
    4_500 => 3,      // Premium-15
    4_000 => 4,      // Premium-30
    _ => return Err(ErrorCode::InvalidLoanOption.into()),
};
```

### Change 2 — Premium tier requires on-chain TWAP gate

For `loan_option ∈ {3, 4}`:

```rust
if tier >= 3 {
    // Premium tier: require multi-sample TWAP, not single-attestation price.
    let twap = ctx.accounts.price_history.twap(now)
        .ok_or(ErrorCode::InsufficientPriceHistory)?;
    let expected_value_twap = (collateral_amount as u128)
        .checked_mul(twap.0)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(10u128.pow(decimals as u32))
        .ok_or(ErrorCode::MathOverflow)?;
    let max_allowed_twap = expected_value_twap
        .checked_mul((BPS_DENOM as u128) + (MAX_VALUE_TOLERANCE_BPS as u128))
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(BPS_DENOM as u128)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(
        (collateral_value as u128) <= max_allowed_twap,
        ErrorCode::CollateralValueExceedsAttestation
    );
}
```

`RequestLoan` accounts struct gets an OPTIONAL `price_history` account when `tier >= 3`. PDA seeds: `[b"price-history", collateral_mint.key().as_ref(), pool.key().as_ref()]`.

The Premium-tier validation runs **in addition to** the existing single-attestation price check, not in place of it. Belt + suspenders.

### Change 3 — Fold in v1 Anchor Finding 1 (fee-wallet-owner constraint)

Add to `LendingPool` state:

```rust
pub fee_authority: Pubkey,  // who must own the fee_wallet_token_account
```

Set in `initialize_pool` to `pool.authority` by default (the lender). Owner constraint on both `request_and_fund_loan` and `extend_loan`:

```rust
#[account(
    mut,
    constraint = fee_wallet_token_account.owner == pool.fee_authority,
    constraint = fee_wallet_token_account.mint == pool.loan_token_mint,
)]
pub fee_wallet_token_account: ...
```

Closes the v1 exploit on v3. The off-chain extend-loan-watcher (shipped 2026-06-09 against v1) continues to cover v1 loans through their natural lifecycle.

### Change 4 — Replace placeholder `declare_id!`

```rust
declare_id!("MgpV3TWAPLending111111111111111111111111111"); // ← placeholder, replace
```

Run `solana-keygen new -o v3-program-keypair.json` to generate the real keypair. Per the keypair-safety memory rule: **save to `~/secure/magpie-v3-program-keypair.json`** with restrictive permissions before doing anything else. Then update `declare_id!` with the resulting pubkey and commit.

### Change 5 — Add regression test

Add `tests/v3-tier-table.ts`:

```typescript
it("tier tables are consistent length and sum-to-100% on fee splits", () => {
  expect(LTV.length).toEqual(5);
  expect(DURATION.length).toEqual(5);
  expect(FEE.length).toEqual(5);
  expect(HOLDER_REWARD_BPS + REFERRAL_REWARD_BPS + LP_LOYALTY_REWARD_BPS + DEFAULT_PROTOCOL_FEE_BPS + LP_FEE_SHARE_BPS).toEqual(10_000);
});
```

Plus a tx-level integration test that creates a Premium-15 and a Premium-30 loan, exercises extend on each, and asserts the new on-chain TWAP gate fires correctly.

---

## 3. Pool structure

**Decision: separate Premium pool, full segregation from v1.**

| Resource | v1 | v3 Premium |
|---|---|---|
| Program ID | `4FEFPeMH68B…` (live) | NEW (generated during deploy) |
| `LendingPool` PDA | `[b"pool", authority]` under v1 program | `[b"pool", authority]` under v3 program (different account, derived from same authority but distinct program ID) |
| `loan_token_vault` | wSOL vault A | wSOL vault B |
| LPs | Existing v1 LP positions | New Premium-pool LP positions, completely separate accounting |
| Fee wallet | LENDER_PUBKEY's wSOL ATA (constrained on v3 via Change 3) | Same wallet, but on a fresh account under v3 |

LPs can deposit to either pool or both. Each pool's fees flow to its own depositor cohort. A Premium-tier liquidation cannot touch v1 LP yield, and a v1 liquidation cannot touch Premium LP yield. This is the load-bearing risk-isolation property.

**Single authority key across both pools.** The operator's `LENDER_PUBKEY` initializes both. Single point of operational control; same key-management posture as today. If the key is ever rotated, both pools are migrated in lockstep.

---

## 4. Eligibility screener wiring

Already drafted in `src/services/premium-tier-screener.js` and spec'd in `PREMIUM-TIER-SCREENER-SPEC.md`. Activation work:

1. `fetchOracleFeedHealth()` stub → real wiring to Pyth SDK. Cache 10s per mint.
2. The 8-gate sequence runs unchanged. Same `{ blocked, reason, message }` shape as `anti-exploit.js`.
3. The borrow flow (`src/services/loans.js`) gets a `pool === "v3-premium"` branch that calls `screenPremiumBorrow()` after the existing anti-exploit gauntlet. **In addition to**, not in place of — Premium borrows pass ALL existing gates AND the screener.
4. Same `loan_option ∈ {3, 4}` distinguishes Premium-15 vs Premium-30 in the screener; both go through the same gates.
5. Per-loan cap (`PREMIUM_TIER_MAX_LOAN_LAMPORTS`) is global; per-token aggregate is from `premium_tier_whitelist.max_open_lamports` per mint.

---

## 5. Initial whitelist seeding

Two whitelist tables seeded at launch — one per track. Both intentionally narrow; widened by operator after 30 days of operating data per track.

### 5a. Equity whitelist (5 tokens)

| # | Symbol | Mint | Why | Per-token cap |
|---|---|---|---|---:|
| 1 | NVDAx | `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` | Top-tier NASDAQ stock, deep on-chain liquidity, Pyth feed available | 10 SOL |
| 2 | COINx | `Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu` | Crypto-correlated equity, natural fit for Solana DeFi audience | 10 SOL |
| 3 | TSLAx | (resolve at seed time) | Established equity, high recognition | 10 SOL |
| 4 | AAPLx | (resolve at seed time) | Established equity, very liquid feed | 10 SOL |
| 5 | MSFTx | (resolve at seed time) | Established equity, low volatility | 10 SOL |

Mints for TSLAx, AAPLx, MSFTx need to be resolved against the live Backed Finance xStocks registry at seed time. `scripts/seed-premium-whitelist.js` does this lookup + insert in one shot.

Each Equity-track whitelisted token must independently:
- Have an active Pyth or Switchboard price feed
- Have >$500K of on-chain DEX liquidity
- Be tagged `category = 'stock'` in `supported_mints`
- Have its `protected` flag set TRUE (signals operator-reviewed)

If any of these fails for a candidate, skip and move to the next. The seeding script halts with a list of failures rather than partial-seeding.

### 5b. Blue-chip Solana memecoin whitelist (4 tokens)

| # | Symbol | Resolution at seed time | Why on the list | Per-token cap |
|---|---|---|---|---:|
| 1 | $PUMP | pump.fun's native token (mint resolved at seed time) | The platform that launched ~all of Solana's memecoin economy. Deepest holder base of any Solana token. Multi-source oracles. | 5 SOL |
| 2 | $BONK | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` | First Solana airdrop memecoin to hit and hold material market cap. Listed on every major CEX. Pyth + Switchboard. | 5 SOL |
| 3 | $FARTCOIN | (mint resolved at seed time) | Top-tier Solana memecoin by volume + holder distribution. Surprisingly resilient through multiple market cycles. | 5 SOL |
| 4 | $TROLL | (mint resolved at seed time — confirm correct $TROLL by liquidity rank if multiple candidates exist) | Established Solana memecoin with persistent on-chain depth + holder base. | 5 SOL |

Each Blue-chip-track whitelisted token must independently:
- Have multiple working price sources (Pyth/Switchboard preferred; DexScreener + Jupiter aggregator as fallback signals)
- Have >$2M of on-chain DEX liquidity at the time of seeding (4× the Equity floor)
- Have at least one CEX listing (signals price-discovery beyond on-chain only)
- Have its `protected` flag set TRUE (signals operator-reviewed)
- Have ≥6 months of price history visible on Pyth / DexScreener
- Pass an extra "no recent major drama" check — no token-program changes, no large-holder sell waves, no oracle attacks recorded in the screener's incident log

If any check fails for a candidate, skip — DO NOT relax the criteria mid-seed. The Blue-chip track exists precisely because the criteria are stricter than the rest of the protocol's approved-collateral set.

### Why the blue-chip cap is 5 SOL not 10 SOL

Equity-track stocks are bounded by traditional-market price discovery (NASDAQ closes nightly; institutional feeds enforce orderly state). Memecoins are not. A 50% intraday drawdown is normal for even the bluest Solana memecoin. At 10 SOL per-token aggregate, the worst-case Premium-pool exposure to one memecoin liquidation cascade is 4× larger than the operator wants to absorb at launch. Halving the cap to 5 SOL preserves the option to ramp up after the first 30 days of data.

---

## 6. Bot integration

| File | Change | Effort |
|---|---|---|
| `src/services/loans.js` | Add `pool === "v3-premium"` branch in `executeBorrow()`. Routes to v3 program ID, fee_wallet_token_account derived from v3 pool's `fee_authority`. Calls `screenPremiumBorrow()` after existing gates. | 1 day |
| `src/services/loans.js` | Add `extendPremium()` mirroring existing `extendLoan` but targeting v3 program. Same screener gate at extend. | 0.5 day |
| `src/services/liquidations.js` | Add v3 program awareness — health watcher polls v3 loans too. Liquidator can liquidate v3 loans via v3's `liquidate_loan` instruction. | 0.5 day |
| `src/services/premium-tier-screener.js` | Wire `fetchOracleFeedHealth()` to Pyth SDK. Add real `simulateLiquidation()` that pulls live pair depth from `mint_market_metadata`. | 0.5 day |
| `src/api/dashboard-api.js` | Surface v3 Premium loans in the user's `/dashboard` view alongside v1 loans, with a "PREMIUM-15" or "PREMIUM-30" label. | 0.5 day |
| `src/handlers/borrow-handlers.js` | Add `/borrow_premium_15` and `/borrow_premium_30` TG commands. Existing `/borrow` flow shows a tier picker that includes Premium-15/Premium-30 IF the borrower is eligible (3+ clean repays, no recent liquidations). | 1 day |
| `src/index.js` | Wire v3 program ID into the bot's program registry. Reads `PROGRAM_ID_V3_PREMIUM` from env. | 0.25 day |
| Env vars | `PROGRAM_ID_V3_PREMIUM`, `PREMIUM_TIER_ENABLED`, `PREMIUM_TIER_MAX_LOAN_LAMPORTS`, `PREMIUM_TIER_MIN_VOLUME_USD`, `PREMIUM_TIER_MAX_UNWIND_SECONDS`, `PYTH_RPC_URL`. Default `PREMIUM_TIER_ENABLED=false` until launch day. | 0.25 day |

**Feature flag.** `PREMIUM_TIER_ENABLED=true` is the master switch. While false, all Premium routes refuse politely with a "coming soon" message. When flipped to true, Premium borrows become possible. Rollback is a single env flip.

---

## 7. Site UI

| File | Change | Effort |
|---|---|---|
| `src/app/borrow/page.tsx` (or wherever the borrow flow lives) | Add Premium-15 + Premium-30 tier cards alongside Express/Quick/Standard. Cards are hidden unless `NEXT_PUBLIC_PREMIUM_TIER_ENABLED === "true"`. Eligible only — gated client-side too, plus server enforces via the screener. | 1 day |
| `src/app/tiers/page.tsx` (if exists) or `/docs#tiers` | Document the 5-tier table with all parameters. | 0.5 day |
| `src/app/dashboard/page.tsx` | Show Premium loans with the "PREMIUM-15" / "PREMIUM-30" label and the correct due-date math. | 0.5 day |
| `src/app/earn/page.tsx` | Add a Premium-pool option — separate deposit / withdraw, separate APY display. Visual distinction (e.g., "STANDARD POOL" vs "PREMIUM POOL"). | 1 day |
| `src/app/calculate/page.tsx` (loan calculator) | Add Premium tiers to the calculator. | 0.5 day |
| `src/app/api/v1/info/route.ts` | Update the public `info` response to include the 5-tier structure. | 0.25 day |
| `src/app/api/v1/eligible-collateral/route.ts` | Return Premium-eligible flag per token. | 0.25 day |
| `src/app/whitepaper/page.tsx` | Update whitepaper to describe Premium tier (including risk + fee differential rationale). | 0.5 day |
| `src/app/api/v1/tiers/route.ts` (if exists) | Update tier list. | 0.25 day |
| `src/app/governance/proposal/[id]/page.tsx` | Add an MGP-NNN page documenting the Premium-tier ship as an operator-discretion event for the historical record. | 0.25 day |

---

## 8. Pip prompt updates

Both `community-pip.js` and `ai-support.js` need:

1. **The new 5-tier table** added to the protocol-facts section. Replace the existing 3-tier table.
2. **Premium-tier eligibility explanation** so Pip can answer "why can't I get Premium?" questions. Same content as Screener gates 1–8, paraphrased for end-user readability.
3. **The "tokenized stocks only" constraint** at launch, with the messaging "memecoin Premium may come later after 90 days of operating data."
4. **The two-pool structure** so Pip can answer "where do I deposit to earn Premium yield?" questions — clear distinction between Standard Pool and Premium Pool.
5. **Updated fee-split table** if MGP-001 has passed by Premium launch (70/10/10/10 — 70% holders / 10% LPs / 10% referrers / 10% protocol reserve) — apply to BOTH pools.

Per the existing memory rules:
- Pip's stale "0 ever liquidations" claim was fixed during the prior audit pass — keep that fix.
- Pip's snapshot rule remains hard-internal.

---

## 9. Public-facing copy

| Surface | Update |
|---|---|
| Whitepaper | Premium tier section added, including the 5-tier table, the screener gates, and the separate-pool rationale |
| Tokenomics | Reference Premium tier as an additional fee source for the holder distribution |
| Site landing | Hero copy stays the same; add a small "5 tiers now: Express → Premium-30" pill if it fits |
| `/api/v1/info` | Include all 5 tiers in the `tiers` array |
| CG / CMC listing applications | Update if active — these now describe a 5-tier protocol, not 3-tier. The CMC ticket #1372062 hasn't been reviewed yet; once Premium ships, file an update request via the same CG dashboard. |
| X announcement (@MagpieLoans) | Single post on launch day: "Premium tier is live — 15-day and 30-day SOL loans against tokenized stocks. New separate LP pool. magpie.capital/borrow" |
| @magpietalk announcement | **Operator green-light required** per the no-broadcast rule. Draft text held until approval. |
| Marketing repo | Coordinated campaign brief stays in private `magpie-marketing` repo. |

---

## 10. Testing requirements

Before flipping `PREMIUM_TIER_ENABLED=true`:

| Test | What | Owner | Pass criterion |
|---|---|---|---|
| Anchor program unit tests | Tier tables 5-long, fee split sums to 10_000, fee_wallet_owner constraint rejects mismatched owner | Engineering | 100% pass on `anchor test` |
| Anchor program integration test | Full Premium-15 borrow → extend → repay; full Premium-30 borrow → extend → liquidate | Engineering | 100% pass |
| Screener unit tests | Each of the 8 gates pass/fail boundaries | Engineering | 100% pass |
| Screener integration test | Mocked Pyth feed + mocked DexScreener pair + real Postgres — verify the full sequence against a known-good Premium borrow AND a known-bad attempt (memecoin, degraded feed, etc.) | Engineering | 100% pass |
| Bot end-to-end | Real testnet/devnet deploy of v3 program + bot routing Premium borrow through the full stack | Engineering | 100% pass; observable success at every stage |
| Site UI flow | Premium tier card → wallet → quote → borrow → success on testnet | Engineering | 100% pass on Phantom, Solflare, Backpack |
| Liquidation race | Trigger a Premium-30 loan past due, observe keeper liquidate within 60s, observe LP accounting update correctly | Engineering | Successful liquidation, LP positions update, no orphaned state |
| Rollback test | Flip `PREMIUM_TIER_ENABLED=false`, attempt new Premium borrow → refused; existing Premium loan repay → succeeds | Engineering | Behavior as expected |

---

## 11. Step-by-step deploy runbook

In strict dependency order. Each step must be ✅ before the next.

| # | Step | Owner | Duration | Verification |
|---|---|---|---|---|
| 1 | Generate v3 program keypair; save to permanent storage per keypair-safety rule | Operator | 1h | Keypair file exists at `~/secure/magpie-v3-program-keypair.json`, perms 0400 |
| 2 | Update `programs/magpie-lending-v3/src/lib.rs` with Changes 1–5 from §2 | Engineering | 1 day | PR merged to main; CI green |
| 3 | Build v3 program: `anchor build -p magpie_lending_v3` | Engineering | 30min | .so file exists in `target/deploy/` |
| 4 | Deploy v3 to devnet for integration testing | Engineering | 1h | Program ID visible on devnet Solscan |
| 5 | Devnet: `initialize_pool` against v3 with operator's wSOL ATA as fee wallet | Engineering | 30min | Pool PDA exists, vault initialized |
| 6 | Devnet: create `PriceHistory` for at least 2 candidate tokens; append samples for 2h to seed the TWAP buffer | Engineering | 2h elapsed (mostly waiting) | `twap()` returns valid sample |
| 7 | Devnet: run the bot's full Premium-15 + Premium-30 end-to-end test flows | Engineering | 4h | All tests pass; no error logs |
| 8 | Devnet: run liquidation race test | Engineering | 4h | Successful liquidation under realistic conditions |
| 9 | Apply Changes 1–8 from §6 (bot integration) to `magpie-bot/main`. Keep `PREMIUM_TIER_ENABLED=false` in prod. | Engineering | 3 days | PRs merged, deployed to prod with flag off |
| 10 | Apply site UI changes from §7. Keep `NEXT_PUBLIC_PREMIUM_TIER_ENABLED=false`. | Engineering | 3 days | Deployed, no visible Premium UI |
| 11 | Update Pip prompts (§8) for both `community-pip.js` and `ai-support.js`. | Engineering | 0.5 day | Deployed; Pip describes 5 tiers when asked |
| 12 | Mainnet: deploy v3 program at the generated keypair (Step 1) | Operator | 1h | Program ID matches expected; on-chain at deploy slot |
| 13 | Mainnet: `initialize_pool` against v3 | Operator | 30min | Pool exists, vault funded with 1 SOL seed deposit from operator |
| 14 | Mainnet: create `PriceHistory` accounts for the 5 whitelist mints; seed sampler to start appending | Operator | 2h elapsed | TWAP buffer warming up |
| 15 | Run `scripts/seed-premium-whitelist.js` against mainnet | Operator | 30min | 5 rows in `premium_tier_whitelist`, all with `enabled = true` and correct caps |
| 16 | Wait 24h for the TWAP buffer to fill to a usable depth | — | 24h elapsed | `twap()` returns samples for all 5 whitelisted mints |
| 17 | Run the full test suite from §10 against mainnet (DO NOT FLIP FLAG YET) | Engineering | 1 day | 100% pass |
| 18 | Update `/api/v1/info` and `/api/v1/tiers` to reflect the 5-tier structure | Engineering | 1h | Live API returns 5 tiers |
| 19 | **Operator green-light required.** Confirm everything is solid; flip `PREMIUM_TIER_ENABLED=true` in bot + `NEXT_PUBLIC_PREMIUM_TIER_ENABLED=true` in site | Operator | 5min | Premium tier UI visible; first test borrow possible |
| 20 | Operator places a small test Premium-15 borrow against NVDAx (~0.5 SOL). Observe success. | Operator | 30min | Loan PDA exists; collateral locked; SOL received |
| 21 | Update CG and CMC ticket #1372062 with the new 5-tier structure (file CG update request) | Operator | 1h | Update tickets submitted |
| 22 | Optional: announce on @MagpieLoans X. **Operator green-light required** for @magpietalk Pip broadcast.| Operator | — | Operator decides |

**Total elapsed:** ~4-6 weeks from go-ahead, dominated by integration testing on devnet (Steps 6-8) and the 24h TWAP warmup window (Step 16). Engineering work itself is ~10 working days; everything else is verification + wait time.

---

## 12. Operational monitoring

After launch, the operator dashboard at `/admin` gets new panels:

| Panel | Source | Cadence |
|---|---|---|
| Premium loans originated (Premium-15 + Premium-30 separately) | DB `loans WHERE pool = 'v3-premium'` | Live |
| Premium-tier liquidation rate (lifetime + 7-day rolling) | DB `loans WHERE status = 'liquidated' AND pool = 'v3-premium'` | Live |
| Premium pool TVL (vault balance + total_deposits) | RPC + v3 pool state | 30s poll |
| Premium pool depositor count + median deposit | DB `depositor_position WHERE pool = v3` | 30s poll |
| Per-mint Premium exposure (against `premium_tier_whitelist.max_open_lamports`) | DB aggregated | Live |
| Premium screener refusal rate by gate ID | Screener structured logs | Live |
| Median screener latency by gate ID | Screener structured logs | Live |
| Per-borrower Premium attempt rate (anti-spam) | Screener structured logs | Live |
| TWAP staleness alerts | Bot service health-check; refuses borrows when TWAP > 10min stale | Live; alert ops within 60s of staleness |

Slack/TG alert when:
- Premium pool TVL drops by >10% in 1h
- Premium-tier liquidation rate exceeds 5% on a rolling 7-day window
- Screener refusal rate for any single gate exceeds 70% in 1h (suggests calibration drift)
- Any feed degradation event lasts >5min

---

## 13. Rollback plan

The simplest rollback: flip `PREMIUM_TIER_ENABLED=false`. Immediately, new Premium borrows refuse politely. Existing Premium loans continue through their natural lifecycle (repay or liquidate). LP withdrawals on the Premium pool continue working — no LP is trapped.

The "softer" rollback if individual tokens prove problematic: disable that token's row in `premium_tier_whitelist` (`enabled = false`). New Premium borrows against that token refuse; existing ones continue.

The "harder" rollback if a fundamental v3 program issue is discovered: pause v3 via `set_paused(true)`. All v3 operations refuse on-chain. Requires a follow-up unpause once the issue is resolved. NEVER redeploy v3 at the same program ID — same memory rule that applies to v1.

The "hardest" rollback: write off all in-flight Premium loans (treat as protocol loss, refund collateral to borrowers). Only justified if the v3 program is found to have a critical bug. Tracked in `incident_response.md` if it ever happens.

---

## 14. Timeline with concrete dates (target)

Assuming go-ahead on 2026-06-09:

| Date | Milestone | Status |
|---|---|---|
| 2026-06-09 | Plan published, operator decision recorded | ✅ this document |
| 2026-06-10 → 2026-06-13 | Steps 1-3: v3 keypair + code + build | Engineering |
| 2026-06-14 → 2026-06-21 | Steps 4-8: devnet integration + testing | Engineering |
| 2026-06-22 → 2026-07-01 | Steps 9-11: bot + site + Pip integration in prod with flag off | Engineering |
| 2026-07-02 → 2026-07-04 | Steps 12-14: mainnet v3 deploy + pool init + TWAP seeding | Operator |
| 2026-07-05 → 2026-07-06 | Steps 16-17: 24h TWAP warmup + final test pass | — |
| 2026-07-07 | **Step 19: launch day.** Operator flips PREMIUM_TIER_ENABLED=true. First Premium-15 test borrow at Step 20. | Operator |
| 2026-07-08 → 2026-07-10 | Steps 21-22: aggregator updates + announcements | Operator |
| 2026-07-10 to 2026-08-09 | First 30-day observation window — gather liquidation rate, LP TVL response, borrower retention data | — |
| 2026-08-09 | First 30-day retrospective + decision on whether to add memecoins to Premium whitelist | Operator |

---

## 15. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| LP capital doesn't migrate to Premium pool | Medium | High | Time-boxed LP-yield bonus during launch; operator seed deposit so the pool isn't empty at flip |
| 30-day liquidation events cluster on correlated equity move | Medium | Medium | Per-token aggregate cap of 10 SOL limits blast radius; screener Gate 5 (liquidation-solvability) refuses borrows above the safe size |
| Pyth feed degradation refuses borrows for hours | Low | Medium | Fallback to off-chain cross-source agreement; alert ops within 60s of staleness |
| v3 has an undiscovered bug | Medium | Catastrophic | Extensive devnet testing in Steps 6-8; mainnet test borrow in Step 20 before announcing; pause-able via `set_paused` |
| Operator key compromise during deploy | Low | Catastrophic | Same key-management posture as today; key never logged, never committed |
| Whitelist token gets de-listed by Backed Finance | Low | Medium | `scripts/disable-token.js` already handles this; same mechanism applies to Premium whitelist |
| Borrower fee-evasion via direct on-chain call | Low | Low | v3 ships the fee_wallet_owner constraint (Change 3); cannot be exploited |
| Holders confused about which pool to deposit to | Medium | Low | Clear UI distinction; Pip prompts updated; FAQ entry added |
| Memecoin advocates push to expand whitelist before data | Medium | Low | Operator commits to 30-day observation window before any whitelist expansion |
| Premium tier underwhelms — too few borrowers | Medium | Low | First 30 days are the data-gathering window; iterate parameters (LTV, fee) based on actual demand |

---

## 16. Decisions documented for future reference

- **Why two duration options not one:** the user explicitly asked for 15-day AND 30-day. Both ship together. Single-duration was considered and rejected.
- **Why tokenized stocks only at launch:** lower volatility + institutional price feeds. Memecoin Premium considered but deferred to the 30-day retrospective.
- **Why separate pool:** risk isolation. v1 LPs cannot be punished for Premium-tier liquidation events.
- **Why operator discretion, not Tier C escalation:** loan-duration changes are Tier B in v0 GOVERNANCE.md. Operator's choice not to escalate is within scope. Future MGP-NNN may move loan-duration into Tier A.
- **Why 45% LTV / 3.5% fee on 15-day and 40% / 5% on 30-day:** shorter duration tolerates more aggressive LTV; longer duration needs lower LTV plus higher fee to compensate for added duration risk. Annualized fee on 15-day (85%) intentionally higher than 30-day (61%) because fixed gate-evaluation costs amortize less per loan.
- **Why MGP-002 was withdrawn:** operator decision made; running the poll to conclusion would have created a "vote that doesn't matter" precedent. Cleaner to withdraw + document the operator-discretion path explicitly.

---

## Related

- [`PREMIUM-TIER-SCREENER-SPEC.md`](./PREMIUM-TIER-SCREENER-SPEC.md)
- [`V3-DEPLOY-READINESS-2026-06-09.md`](./V3-DEPLOY-READINESS-2026-06-09.md)
- [`SECURITY-AUDIT-ANCHOR-2026-06-09.md`](./SECURITY-AUDIT-ANCHOR-2026-06-09.md)
- [`src/services/premium-tier-screener.js`](../src/services/premium-tier-screener.js) — draft module
- [`src/services/extend-loan-watcher.js`](../src/services/extend-loan-watcher.js) — v1 Finding 1 watcher
- [Withdrawn MGP-002](https://github.com/magpiecapital/magpie-site/blob/main/proposals/MGP-002-extended-duration-tier-signal-poll.md) — for the historical record
