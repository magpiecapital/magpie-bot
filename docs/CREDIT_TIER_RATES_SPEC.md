# Credit-Tier Rate Discount — On-Chain Upgrade Spec

This document specifies the on-chain program changes needed to wire actual
fee discounts to the credit-tier system. Today the credit score (300-850)
and tier (bronze/silver/gold/platinum) are computed but have no on-chain
economic effect. This upgrade makes them load-bearing.

**This is a program-level change. Do not ship without:**
- Audit sign-off (don't deploy unaudited upgrade)
- A migration plan for in-flight loans
- A pause window during the upgrade

## Goal

When a user borrows, the fee they pay should be discounted based on their
credit score tier. This gives repeat users a real economic incentive to
build credit and stay on-time.

## Tier definitions (matches existing off-chain tier_for logic)

| Tier      | Score range | Fee discount      |
|-----------|-------------|-------------------|
| Bronze    | 300-499     | 0% (base rate)    |
| Silver    | 500-649     | -0.25 percentage pts |
| Gold      | 650-749     | -0.50 percentage pts |
| Platinum  | 750-850     | -0.75 percentage pts |

So a Platinum borrower on Standard tier (1.5% base fee) pays 0.75% — half.
A Bronze user pays the full 1.5%.

Encoded on-chain as **basis-point reduction** so the math is integer-clean:
- Bronze:   0 bps off
- Silver:  25 bps off
- Gold:    50 bps off
- Platinum: 75 bps off

## Required on-chain changes

### 1. Add `credit_score_oracle` account

Authority-signed account that publishes user credit scores. Already partially
designed (see `src/services/credit-oracle-publisher.js` — currently disabled).
Re-enable this with a dedicated authority wallet.

Structure:
```rust
#[account]
pub struct CreditScoreAccount {
    pub user: Pubkey,
    pub score: u16,           // 300-850
    pub tier: u8,             // 0=bronze, 1=silver, 2=gold, 3=platinum
    pub updated_at: i64,
    pub bump: u8,
}
```

PDA: `[b"credit", user.key().as_ref()]`

### 2. Modify `request_and_fund_loan` instruction

Add optional `credit_score` account to the accounts list. If present and
fresh (updated within last 24h), apply the tier discount to fee calculation.

```rust
// Before:
let fee_bps = match tier {
    Express => 300,
    Quick => 200,
    Standard => 150,
};
let fee = loan_amount.checked_mul(fee_bps).unwrap().checked_div(10_000).unwrap();

// After:
let mut fee_bps = match tier {
    Express => 300,
    Quick => 200,
    Standard => 150,
};
if let Some(credit) = ctx.accounts.credit_score.as_ref() {
    let age = Clock::get()?.unix_timestamp - credit.updated_at;
    if age < 86_400 && credit.user == ctx.accounts.borrower.key() {
        let discount = match credit.tier {
            0 => 0,   // Bronze
            1 => 25,  // Silver
            2 => 50,  // Gold
            3 => 75,  // Platinum
            _ => 0,
        };
        fee_bps = fee_bps.saturating_sub(discount);
    }
}
let fee = loan_amount.checked_mul(fee_bps).unwrap().checked_div(10_000).unwrap();
```

### 3. Apply same to `extend_loan`

Extension fees should get the same discount.

## Off-chain changes (after on-chain deploy)

1. **Bot `/borrow` flow**: pass the credit_score PDA in account list when
   present. Use `getProgramAccountInfo` to check freshness.
2. **`/simulate`**: read the user's current tier from `credit_scores` DB
   table and show the effective fee in the preview.
3. **AI agent prompt**: update the fee descriptions in `CORE PROTOCOL FACTS`
   to mention tier discounts.
4. **Credit oracle publisher**: re-enable `src/services/credit-oracle-publisher.js`.
   Currently disabled (line 230-231 in src/index.js) because it needs a funded
   authority wallet. Set up a dedicated keypair for publishing.

## Risks + mitigations

| Risk | Mitigation |
|------|------------|
| Bad oracle publish nukes everyone's discount | Discount is OPTIONAL on the account; if oracle stale, falls back to base rate |
| Authority key compromise | Score publishes are READ-ONLY, can't move funds. Worst case: someone publishes wrong scores. Rotate authority. |
| Stale score abuse | 24h freshness check enforced on-chain |
| In-flight loans during upgrade | They keep paying the rate they signed; only NEW loans see new fees |

## Rollout plan

1. Get audit sign-off on the upgrade (incremental — should be cheap)
2. Pause new borrows (admin /pause)
3. Deploy program upgrade via authority
4. Publish credit scores for top ~100 active users (warm cache)
5. Unpause
6. Monitor first ~10 borrows for correct discount application
7. Announce publicly

## Expected impact

- **Retention**: Trusted/Platinum users have a sticky reason to keep using
  Magpie vs jumping to a competitor
- **Volume**: Lower fees on repeat borrowers grow with the user base
- **Story**: "On-chain credit that actually affects your rate" is a strong
  marketing line — no other Solana lender has this
- **Cost to protocol**: Discount comes out of the 3% protocol share, not LP
  share. Worst case (everyone Platinum): protocol earns ~2.25% instead of
  3%. Manageable.
