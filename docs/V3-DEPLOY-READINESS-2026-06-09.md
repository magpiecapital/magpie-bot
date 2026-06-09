# `magpie-lending-v3` deploy-readiness audit — 2026-06-09

Companion to MGP-002 + the Premium-tier screener spec. Assesses what would have to change in `programs/magpie-lending-v3/src/lib.rs` (1811 LoC) to deploy a Premium tier alongside the existing v1 pool.

**Status:** v3 scaffold exists with a placeholder `declare_id`. Never deployed. Same instruction surface as v1 plus an on-chain TWAP price-history module.

---

## 1. What v3 already has that v1 doesn't

The v3 file is 214 LoC longer than v1 (1811 vs 1597). The delta is entirely an on-chain TWAP module:

- `PriceHistory` account — ring buffer of `PRICE_HISTORY_CAPACITY` `PriceSample` slots
- `append(sample)` — appends to the head, wraps when full
- `latest()` — returns the most recent sample
- `twap(now)` — computes time-weighted average price over the buffer's window

The price feed authority appends samples on a cadence (similar to the existing off-chain TWAP gate, but now on-chain and uncircumventable by a malicious caller).

**Implication for Premium tier:** the on-chain TWAP is exactly the gate we want for a 30-day loan. Long-duration loans benefit MOST from manipulation-resistant pricing — a 30-second oracle blip during a borrow window matters less if the program rejects borrows whose `collateral_value` is more than X% above the multi-sample TWAP, not just the single-attestation price. v3 ships this.

What v1 has but v3 also keeps:
- 3-tier table (`TIER_LTV_BPS / TIER_DURATION_DAYS / TIER_FEE_BPS` — still `[u64; 3]`)
- All 13 instructions (deposit, withdraw, borrow, repay, partial-repay, add-collateral, extend, liquidate, init-pool, init-feed, update-price, set-paused, set-keeper-reward, admin-withdraw)
- Identical PDA seed schemes and authority constraints
- The same `request_and_fund_loan` authority co-sign requirement

---

## 2. What needs to change in v3 for Premium tier

Five contained changes, ~50 LoC total.

### Change 1 — Expand the tier table

```rust
// Before (current v3 state)
const TIER_LTV_BPS: [u64; 3] = [3_000, 2_500, 2_000];
const TIER_DURATION_DAYS: [i64; 3] = [2, 3, 7];
const TIER_FEE_BPS: [u64; 3] = [300, 200, 150];

// After
const TIER_LTV_BPS: [u64; 4] = [3_000, 2_500, 2_000, 4_000];
const TIER_DURATION_DAYS: [i64; 4] = [2, 3, 7, 30];
const TIER_FEE_BPS: [u64; 4] = [300, 200, 150, 500];
```

Validation in `request_and_fund_loan`: `require!(loan_option <= 3, ErrorCode::InvalidLoanOption);`.

### Change 2 — Validate Premium tier requires the on-chain TWAP gate

```rust
let tier = loan_option as usize;
if tier == 3 {
    // Premium tier: require multi-sample TWAP, not single-attestation price.
    let twap = ctx.accounts.price_history.twap(now)
        .ok_or(ErrorCode::InsufficientPriceHistory)?;
    // collateral_value <= twap-derived ceiling (with the existing 3% tolerance).
    let expected_value = (collateral_amount as u128)
        .checked_mul(twap.0)
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(10u128.pow(decimals as u32))
        .ok_or(ErrorCode::MathOverflow)?;
    let max_allowed = expected_value
        .checked_mul((BPS_DENOM as u128) + (MAX_VALUE_TOLERANCE_BPS as u128))
        .ok_or(ErrorCode::MathOverflow)?
        .checked_div(BPS_DENOM as u128)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(
        (collateral_value as u128) <= max_allowed,
        ErrorCode::CollateralValueExceedsAttestation
    );
}
```

`RequestLoan` accounts struct gets an optional `price_history` account when `tier == 3`. PDA seeds: `[b"price-history", collateral_mint.key(), pool.key()]`.

### Change 3 — Fix the v1 fee-wallet-owner constraint (Finding 1 from the Anchor audit)

While the program is being redeployed for the tier expansion, fold in the v1 `extend_loan` finding from `SECURITY-AUDIT-ANCHOR-2026-06-09.md`. Add `fee_authority: Pubkey` to `LendingPool` state (default to `pool.authority` at init); add the `owner` constraint on `fee_wallet_token_account`:

```rust
#[account(
    mut,
    constraint = fee_wallet_token_account.owner == pool.fee_authority,
    constraint = fee_wallet_token_account.mint == pool.loan_token_mint,
)]
pub fee_wallet_token_account: ...,
```

Closes the `extend_loan` finding **and** the latent `request_and_fund_loan` shape. Trivial code change; meaningful security improvement.

### Change 4 — Add `pool` discriminator support so the bot can tell v1 from v3 loans

Loan accounts created against v3 use a different program ID, so on-chain account discriminator already differs. No state change needed; just bot-side awareness that `borrower_wallet` may have loans across both programs and they should be summed correctly for limit checks.

### Change 5 — Replace placeholder `declare_id!`

```rust
declare_id!("MgpV3TWAPLending111111111111111111111111111"); // ← placeholder, replace
```

Generate a fresh keypair (`solana-keygen new -o v3-program-keypair.json`), copy the pubkey into `declare_id!`, save the keypair to permanent storage (per the keypair-safety memory rule — never generate without saving to a permanent file first).

---

## 3. Out-of-program work required for first Premium-tier loan

In dependency order:

| # | Work | Owner | Effort |
|---:|---|---|---:|
| 1 | MGP-002 signal poll closes with Q1 + Q2 passing | Governance | Vote cycle (3 days + scope review) |
| 2 | MGP-003 Tier C escalation closes with PASS | Governance | Higher-bar vote cycle |
| 3 | MGP-004 binding Tier A proposal closes with PASS | Governance | Vote cycle |
| 4 | Apply Changes 1–5 to `programs/magpie-lending-v3/src/lib.rs` | Engineering | ~1 day |
| 5 | Build, anchor test, deploy v3 to mainnet | Engineering | 1 day |
| 6 | Initialize v3 pool via `initialize_pool` with fresh `fee_wallet` + Premium-tier params | Engineering | 1 hour |
| 7 | Create `premium_tier_whitelist` table; seed 5–10 stocks per `scripts/seed-premium-whitelist.js` | Engineering | 2 hours |
| 8 | Wire `screenPremiumBorrow()` into bot's borrow flow behind `PREMIUM_TIER_ENABLED` feature flag | Engineering | 1 day |
| 9 | Build & ship site UI Premium tier card (gated behind same flag) | Engineering | 1 day |
| 10 | Update Pip prompts (community + site/wallet) to know about Premium tier mechanics | Engineering | 2 hours |
| 11 | Public docs / whitepaper / tokenomics / `/api/v1/info` updated | Engineering | 2 hours |
| 12 | Test coverage at 100% on screener gates (see PREMIUM-TIER-SCREENER-SPEC.md §5) | Engineering | 1 day |
| 13 | Flip `PREMIUM_TIER_ENABLED=true` in production | Operator | 5 minutes |

**Realistic timeline from go-ahead to first Premium loan:** 4–6 weeks. Governance cycles (steps 1–3) dominate; engineering work (4–12) is ~6 working days bundled.

---

## 4. Risks specific to deploying v3 alongside v1

1. **Two programs, two pools, two LP cohorts.** LPs must choose which pool to deposit into. Initial Premium pool depth will be limited until LPs allocate. Mitigation: seed deposit from operator and time-boxed Premium LP-yield bonus during the launch window.
2. **Borrower confusion.** A user with active v1 loans + new v3 Premium loan sees two parallel positions. Mitigation: dashboard combines both views; copy is unambiguous about which tier each loan is on.
3. **Per-wallet limits split.** Existing limits (3 SOL new tier, 10 SOL trusted tier) need a decision: aggregate across v1 + v3, or independent. Recommend independent — Premium loans count against a SEPARATE Premium-only cap.
4. **Operational complexity.** Two programs to monitor, two pools' health to dashboard, two sets of liquidation watchers. Real ongoing cost.
5. **v3 deploy keypair safety.** Per the keypair-safety memory rule: NEVER generate without saving to a permanent file first. Track the v3 program keypair in the same secure storage as the lender keypair.

---

## 5. What's NOT changing

- The v1 lending program. Existing v1 pool, existing v1 loans, existing v1 LP positions are entirely untouched. Memory rule "Never redeploy the live lending program at same program ID" is preserved.
- The existing Express/Quick/Standard tier values. Those remain governed by the existing A2/A3 proposal paths.
- The credit-oracle program. Premium-tier loans contribute to the same credit score; on-time Premium repays boost score, Premium liquidations tank it.
- The x402 paid agent API. Agents can borrow on Premium tier via the existing `build-borrow` endpoint with `loan_option=3` once v3 is live; new endpoint not required.

---

## 6. Go/no-go signals to watch after launch

- **Premium-tier weekly origination volume** — health proxy. Below 5 SOL/week = product-market fit problem.
- **Liquidation rate on Premium tier** — keep separate from v1 stats. If Premium liquidation rate exceeds 5%, the screener is too loose or the LTV is too high.
- **Premium pool depth** — if depth never exceeds 50 SOL within 30 days of launch, LP appetite is the constraint, not borrower demand.
- **Operator unwind speed** — measure actual seconds-from-due-to-liquidation in Premium. Compare against the screener's simulator estimate. Iterate the simulator on drift.

---

## 7. Related

- [MGP-002](https://github.com/magpiecapital/magpie-site/blob/main/proposals/MGP-002-extended-duration-tier-signal-poll.md) — signal poll
- [`PREMIUM-TIER-SCREENER-SPEC.md`](./PREMIUM-TIER-SCREENER-SPEC.md) — off-chain eligibility gate
- [`src/services/premium-tier-screener.js`](../src/services/premium-tier-screener.js) — draft module
- [`SECURITY-AUDIT-ANCHOR-2026-06-09.md`](../SECURITY-AUDIT-ANCHOR-2026-06-09.md) — v1 audit findings (Finding 1 should be folded into v3 alongside the tier expansion)
