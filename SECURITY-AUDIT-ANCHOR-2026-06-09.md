# magpie-lending Anchor program — security review 2026-06-09

Structural review of the live lending program at `4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh` (`programs/magpie-lending/src/lib.rs`, 1597 lines). **Read-only review** — per operator policy the live program cannot be redeployed at the same program ID, so findings are documented here for parallel-program migration consideration.

Not a formal audit. Focus: how a malicious caller could drain pool funds, evade fees, or escape constraint checks.

## What the design gets right

1. **Checked math everywhere.** Every arithmetic op uses `checked_add`/`checked_mul`/`checked_div`/`checked_sub` with `MathOverflow` error. `u128` used for intermediate multiplications. No silent wraps.
2. **PDA seeds are deterministic and bound to identity.** Loan = `[b"loan", borrower, loan_id]`. Collateral vault = `[b"collateral-vault", loan]`. Pool = `[b"pool", authority]`. Price feed = `[b"price", mint, pool]`. Position = `[b"position", pool, depositor]`. No seed reuse, no enumerable IDs that would let a caller claim someone else's PDA.
3. **`has_one` constraints on loan-modifying instructions.** `repay_loan`, `partial_repay`, `add_collateral`, `extend_loan` all verify `loan.borrower == borrower.signer.key()`. Prevents one borrower from operating on another's loan.
4. **Token-2022 collateral via `token_interface::transfer_checked`.** Decimals included in the transfer call — defeats a malicious mint that lies about decimals in subsequent reads.
5. **Price attestation is signer-gated + age-gated.** Only pool authority can update the price feed; loans require an attestation ≤120 seconds old; submitted `collateral_value` is bounded to attested price + 3%.
6. **Loan account close on repay is explicit** — status flips to `Repaid`/`Liquidated`, not closed-with-rent-refund. No init-after-close exploit.
7. **Liquidation is permissionless but with destination constraints.** `keeper_collateral_account.owner == keeper.key()` and `authority_collateral_account.owner == pool.authority`. The caller cannot redirect the collateral to a third party.
8. **Pool authority must co-sign every borrow.** `request_and_fund_loan` requires both `borrower: Signer` AND `authority: Signer`. The authority's bot validates accounts before signing.

## Findings

### Finding 1 — HIGH severity, not fixable in v1
**`extend_loan` lets the borrower redirect `protocol_cut` to themselves.**

The `ExtendLoan` accounts struct only constrains the fee wallet account's mint, not its owner:

```rust
#[account(
    mut,
    constraint = fee_wallet_token_account.mint == pool.loan_token_mint,
)]
pub fee_wallet_token_account: Account<'info, TokenAccount>,
```

The instruction has NO authority co-signer. The borrower signs alone, supplies all accounts, and triggers this transfer chain:

```rust
// borrower → vault: full extension_fee
// vault → fee_wallet_token_account: protocol_cut   ← borrower-controlled destination
```

An attacker constructing the transaction directly (bypassing the bot) can supply their own ATA as `fee_wallet_token_account`, paying `extension_fee` and immediately receiving `protocol_cut` back. Net cost: `extension_fee − protocol_cut`.

At the current `protocol_fee_bps = 300` (3%), an attacker recovers 3% of every extension. The bot-mediated flow at `magpie-bot/src/services/loans.js:213-218` uses a hardcoded `feeWalletWsolAta` from `LENDER_PUBKEY`, so the bot path is safe — but the on-chain program does not enforce this; any direct on-chain caller can exploit.

**Cannot fix in v1.** Memory rule: "Never redeploy the live lending program at same program ID — touches every existing loan." The remediation belongs in the next program version (`magpie-lending-v2` or `-v3`):

```rust
#[account(
    mut,
    constraint = fee_wallet_token_account.owner == pool.fee_authority,
    constraint = fee_wallet_token_account.mint == pool.loan_token_mint,
)]
```

(`fee_authority` needs to be added to `LendingPool` state; default to `pool.authority` on init.)

**Operational mitigations available today:**
- Add a database trigger or off-chain watcher that scans every confirmed `extend_loan` tx and verifies the `fee_wallet_token_account` matches the expected ATA. Borrowers detected exploiting this get a credit-score penalty, a ban, or both. Reactive but enforceable.
- Audit the protocol's accumulated `fee_wallet` SOL receipts vs `total_fees_earned * protocol_fee_bps / BPS_DENOM` — discrepancy reveals exploitation history.

### Finding 2 — MEDIUM severity, mitigated by bot validation
**`request_and_fund_loan` has the same shape, but the authority co-sign closes the gap.**

`RequestLoan` accounts only constrain the fee wallet by mint via a handler-body check:

```rust
require!(
    ctx.accounts.fee_wallet_token_account.mint == ctx.accounts.pool.loan_token_mint,
    ErrorCode::PriceMintMismatch
);
```

No owner check. Same shape as Finding 1. The mitigation: every borrow requires `authority: Signer` (the pool authority co-signs), and the bot constructing the tx uses a hardcoded `feeWalletWsolAta` derived from `LENDER_PUBKEY`. A malicious borrower can rewrite the fee wallet, but the authority signature will be invalid for the rewritten tx — Solana rejects.

Net: not exploitable as long as the authority signs only via the bot path. If a future code path lets the authority sign arbitrary user-supplied account sets (e.g. a "manual sign" admin endpoint), the vulnerability reopens.

**Mitigation today:** keep all authority co-signs gated through `magpie-bot/src/services/loans.js`. No "raw sign" admin path.

**v2/v3 fix:** apply the same `owner` constraint as in Finding 1.

### Finding 3 — MEDIUM severity, correctness/transparency
**Depositor yield is accumulated as orphaned vault buffer, not as on-chain share appreciation.**

The comment at `request_and_fund_loan` says depositors earn the `pool_cut` portion of each fee "via share appreciation." Working through the accounting:

- Fee taken: `vault −= net_loan + protocol_cut` (the pool_cut stays in vault)
- `total_deposits`: NOT incremented by pool_cut
- `total_shares`: unchanged

Withdraw computes `amount = shares × total_deposits / total_shares`. Because `total_deposits` never increases from fees, the per-share value remains 1:1 with principal. The `pool_cut` accumulates in the vault but the withdraw math doesn't claim it.

Result: physical vault balance > sum of redeemable share values. The extra is unclaimed.

If LPs are receiving their advertised 80% yield, it must be via an off-chain mechanism (e.g., the operator periodically `admin_withdraw`s the buffer and distributes via SOL transfers). The on-chain code itself does not implement the yield.

**Impact:** correctness/transparency. Not a drain — but the protocol's documented economics aren't reflected in the on-chain program; LPs trust the operator to distribute. The README, whitepaper, and Pip prompts say "deposit SOL → earn 80% of fees pro-rata"; the on-chain truth is "earn principal back; the operator distributes yield off-chain."

**v2/v3 fix:** increment `total_deposits` by `pool_cut` inside `request_and_fund_loan` (and `extend_loan`'s fee path) so the buffer becomes claimable via withdraw.

Or, document the off-chain yield distribution as a deliberate design choice and update the public-facing copy.

### Finding 4 — LOW severity, by design
**`admin_withdraw` is unbounded.**

The pool authority can withdraw any amount of loan tokens from the vault at any time. This is the documented "emergency admin recovery" path. The security model assumes the authority key is well-protected.

The same key signs every borrow and every price update — its compromise is the protocol's top single-point-of-failure. No mitigation in code; protected by operational key management.

**Future consideration:** v2/v3 could add a multisig requirement or a time-locked withdraw queue for amounts above a threshold. Trade-off: operational friction for emergency response.

### Finding 5 — LOW severity, by design
**Single on-chain price source; staleness window is 120 seconds.**

The on-chain program enforces price ≤120s old + a 3% tolerance on submitted collateral_value. Price comes from a single authority-signed feed; there is no multi-oracle aggregation in the program itself.

Off-chain, the bot runs the layered TWAP / cross-source / post-borrow gauntlet (per the post-2026-06-07 hardening). All those gates fire before the bot signs `request_and_fund_loan`. The on-chain program's price check is a last-line check, not the primary defense.

**Future consideration:** v2/v3 could accept aggregated price proofs from multiple oracles directly on-chain. Adds complexity without obvious benefit while the bot-side gauntlet is the load-bearing defense.

### Finding 6 — LOW severity, observed
**Math edge case in `withdraw`'s deposited_amount reduction.**

At `withdraw` line 303:
```rust
.checked_div(position.shares.checked_add(shares).unwrap())
.unwrap_or(position.deposited_amount);
```

The `.unwrap()` inside `checked_add` would panic on overflow (vs the typical `?` pattern that returns an error). Anchor catches panics and returns a generic error, so the user sees `InstructionError` instead of `MathOverflow`. Cosmetic.

## Areas NOT covered by this review

- `magpie-lending-v2` and `magpie-lending-v3` (parallel programs, not deployed). If/when those go live, they get their own review.
- `magpie-credit-oracle` program. Separate concern.
- `vault-consumer` and `agent-vault`. Separate concerns.
- Whether the operator's bot consistently validates account inputs before authority signing. Spot-checked `loans.js` and saw `feeWalletWsolAta` is hardcoded. Other bot paths (`agent.js`, `agent-manage.js`) referenced `feeWalletWsolAta` too — assumed correct without exhaustive trace.
- Compute unit / heap exhaustion attacks via account count.
- Anchor framework version-specific CPI guards.

## Sign-off

Review by Claude on behalf of the operator, 2026-06-09. Five findings logged. Finding 1 is exploitable today on the live program; Finding 2 is mitigated by the bot-mediated authority co-sign; Finding 3 affects yield distribution transparency. None permits draining the pool of user collateral or borrowed SOL outright. The v2/v3 parallel-program migration should include explicit fee-wallet `owner` constraints (Findings 1 + 2) and either on-chain yield distribution or explicit operator-distribution documentation (Finding 3).
