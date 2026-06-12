# F-7 `liquidate_loan` On-Chain Signer Check — Verified Safe

> **Status:** Verified safe by direct read of the Anchor source. No code changes required.
>
> **Audit finding:** F-7 (Informational, 2026-06-12 V1/V2 security audit). The audit flagged that `liquidate_loan` is permissionless ("any wallet can call") and asked us to verify the on-chain program enforces that the keeper is the only recipient of the bounty and the pool authority gets the remainder. If those checks weren't present, an attacker could permissionlessly liquidate due loans and siphon collateral to themselves.

---

## Audit verification

Direct read of `programs/magpie-lending/src/lib.rs:1301-1346` (V1) and `programs/magpie-lending-v2/src/lib.rs:1306-1351` (V2). The V1 and V2 `LiquidateLoan` Anchor account struct are byte-identical:

```rust
#[derive(Accounts)]
pub struct LiquidateLoan<'info> {
    #[account(mut)]
    pub pool: Account<'info, LendingPool>,

    #[account(mut, has_one = pool, has_one = collateral_mint)]
    pub loan: Account<'info, Loan>,

    pub collateral_mint: Box<InterfaceAccount<'info, MintIfc>>,

    #[account(
        mut,
        seeds = [b"collateral-vault", loan.key().as_ref()],
        bump = loan.vault_bump,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    /// Keeper's token account — receives the keeper bounty portion
    #[account(
        mut,
        constraint = keeper_collateral_account.owner == keeper.key(),
        constraint = keeper_collateral_account.mint == loan.collateral_mint,
    )]
    pub keeper_collateral_account: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    /// Authority's token account — receives the remaining collateral
    #[account(
        mut,
        constraint = authority_collateral_account.owner == pool.authority,
        constraint = authority_collateral_account.mint == loan.collateral_mint,
    )]
    pub authority_collateral_account: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    /// The keeper (liquidator) — permissionless, any wallet can sign
    #[account(mut)]
    pub keeper: Signer<'info>,
    // ...
}
```

Constraints that close the audit's concern:

| Concern | How the program closes it |
|---|---|
| "Anyone can liquidate" | True — `keeper` is `Signer<'info>` with no PDA/address constraint. This is **correct** for a permissionless keeper bounty model. |
| "Attacker could siphon collateral to themselves" | **Closed.** `authority_collateral_account.owner == pool.authority` — the remaining collateral CAN ONLY go to the pool authority's ATA, regardless of who calls the ix. The attacker-as-keeper gets only the bounty portion. |
| "Attacker could siphon the bounty to a different wallet" | **Closed.** `keeper_collateral_account.owner == keeper.key()` — the bounty CAN ONLY go to the calling keeper's own ATA. They can't deposit their bounty into a wash account. |
| "Attacker could liquidate non-due loans" | **Closed.** Function body checks `now > loan.due_timestamp` with `require!(..., ErrorCode::LoanNotDue)` (V1 line 801, V2 line 806). |
| "Attacker could liquidate a non-active loan" | **Closed.** Function body checks `loan.status == LoanStatus::Active` with `require!(..., ErrorCode::LoanNotActive)` (V1 line 798, V2 line 803). |
| "Bounty math could overflow into authority's share" | **Closed.** All arithmetic uses `checked_mul` / `checked_div` / `checked_sub` returning `ErrorCode::MathOverflow` on overflow. |

## Summary

The on-chain `liquidate_loan` is correctly designed. The audit's Informational concern was a "verify these constraints exist" ask, not a found vulnerability. The constraints exist and are tight. No action required.

This is the intended keeper-bounty model: anyone can act as a liquidator, but the on-chain account constraints lock down where the funds go. The protocol pays the bounty as the incentive for the keeper to do the on-chain work, and the rest of the collateral lands in the pool authority's account for off-chain swap and pool recovery.

## Out of scope

The bounty PERCENTAGE (`keeper_reward_bps`) is set by the pool authority. A compromised authority could set it to 100% and have keepers liquidate everything to themselves. That's a separate concern covered by F-1 (multisig the pool authority) — see `docs/F1_MULTISIG_MIGRATION_RUNBOOK.md`. F-7 is specifically about the per-instruction account constraints, which are sound.

## Audit reference

F-7 in the 2026-06-12 V1/V2 security audit. This doc closes the finding.
