# Sec3 V4 Findings — Coverage in the Unaudited Pools (V1, V3)

**Purpose.** Sec3 audited **V4** (final report 2026-08-09: 24 findings, 20 resolved, 4
acknowledged, 0 open). This is the evidence-based confirmation that **every** finding is
accounted for in the two live unaudited lending programs — V1 (memecoin, `magpie-lending`,
`4FEFPeMH…`) and V3 (RWA, `magpie-lending-v3`, `B8AwYzFm…`) — either **ported**, **already
covered**, **not applicable**, or **documented as an accepted design choice**.

**Status:** code complete on branch `security/port-sec3-h01-v1-v3` (PR #674, merged). **Both programs
`cargo check` clean AND now build to deployable SBF `.so` artifacts** (verified 2026-08-14 — V1
465,328 B `2621723b…`, V3 500,848 B `763d698c…`; toolchain + reproducible pin recipe in
`V1_V3_DEPLOY_PLAN.md` §3a/§3b). **Program IDs unchanged. NOT deployed** — deploy is gated on operator
go + a migration plan at a new program id.

Legend: ✅ ported · ☑️ already covered (verified) · ⊘ not applicable · 📝 documented choice ·
⚠️ operator decision needed.

| # | Finding | V1 | V3 | Evidence / rationale |
|---|---|---|---|---|
| **H-01** | Unchecked Token-2022 extensions | ✅ | ✅ | `assert_collateral_custody_safe` + vault-received measurement. **Adapted:** V1 rejects PermanentDelegate+NonTransferable; V3 rejects NonTransferable only (PermanentDelegate is the norm for RWAs — full reject would brick every stock/metal borrow). |
| **H-02** | Compromised engine steals collateral | ⊘ | ⊘ | No `convert_collateral_slice` / auto-sell engine in V1/V3. |
| **M-01** | Loan extension lacks health check | ⚠️ | ⚠️ | Q-02 overdue-refusal added (below). A full mid-life LTV re-check on extend is **not** ported: extending only delays liquidation for a fee and never releases collateral or increases the loan, so it is not a value-extraction vector. Adding it would stop a not-yet-overdue but underwater borrower from extending — a UX change. **Flagged for operator decision.** |
| **M-02** | Fully repaid loans still liquidatable | ☑️ | ☑️ | `liquidate_loan` requires `status == Active` **and** `now > due_timestamp` in both. A repaid loan (status≠Active) cannot be liquidated. |
| **M-03** | Oracle floor ignores decimal normalization | ☑️ | ☑️ | Valuation divides by `10u128.pow(decimals)` — collateral value is decimal-normalized. |
| **M-04** | Pool authority price trust | ✅ | ✅ | `update_price` now bounds a single update to ≤100× either way (`price_change_within_bound` + `MAX_PRICE_UPDATE_FACTOR`) + monotonic-timestamp guard. Same mitigation V4.1 adopted. |
| **L-01** | Same-timestamp samples weaken TWAP | ⊘ | ☑️ | V1 has no TWAP. V3 already requires `oldest_age >= MIN_HISTORY_SECONDS` **and** `MIN_SAMPLES_FOR_TWAP` — same-timestamp spam adds no time coverage, so it can't weaken the gate. Identical to audited V4.1. |
| **L-02** | Liquidation recoveries not returned to LPs | 📝 | 📝 | Model difference: V1/V3 send collateral to the authority on default and credit LPs via the **off-chain `/recover`** path (no in-vault conversion exists). V4's on-chain recovery-to-LP fix does not map. |
| **L-03** | Upfront `pool_cut` first-exit advantage | ☑️ | ☑️ | `pool_cut` stays in the vault (LPs earn via share appreciation); no upfront cut is skimmed to an exiting LP. |
| **L-04** | Auto-sell uses spot not TWAP | ⊘ | ⊘ | No auto-sell. |
| **L-05** | Missing pool binding weakens oracle floor | ☑️ | ☑️ | `price_feed` is a PDA seeded `[b"price", mint, pool]` — cryptographically bound to both the collateral mint and the pool; plus `PriceMintMismatch` handler checks. A foreign/substituted feed cannot be passed. |
| **L-06** | Dust debt extends loan without fee | ✅ | ✅ | Extension fee now rounds **up** and `require!(fee > 0)` — a dust-balance loan can't extend for free via floor division. |
| **L-07** | Old shares steal new deposits | ☑️ | ☑️ | Share math uses the **internal `total_deposits` counter** (not live vault balance, so a donation can't inflate it) and `require!(shares > 0)` rejects a rounds-to-zero deposit. Standard share-inflation defense. |
| **L-08** | Swap allowlist route semantics | ⊘ | ⊘ | No swap CPI / auto-sell. |
| **I-01** | Missing wSOL mint checks | ☑️ | ☑️ | Loan-asset accounts are constrained `token::mint = loan_token_mint` against the pool's mint, and the vault is a per-pool PDA — a foreign loan mint cannot be substituted. |
| **I-02** | Admin excess ignores outstanding loans | 📝 | 📝 | `admin_withdraw` is a deliberate **authority-gated emergency** lever (recover stuck funds). Capping it to "excess minus outstanding loans" could brick a legitimate recovery. Authority is already fully trusted for this pool. Accepted trust-model item (same class as V4's acknowledged M-04). |
| **I-03** | Liquidation event reports wrong amounts | ☑️ | ☑️ | Amounts (`keeper_reward`, `authority_amount`) are computed locally from `loan.collateral_amount`, which — with H-01's receipt check — equals the actual locked collateral. No reported-vs-real divergence. |
| **I-04** | Tiny loans avoid fees | ✅ | ✅ | Origination fee rounds **up** and `require!(fee > 0)`. |
| **I-05** | Unsynced wSOL inflates proceeds delta | ⊘ | ⊘ | Specific to the in-vault conversion **proceeds delta**, which V1/V3 don't have. |
| **I-06** | Tiny conversions avoid protocol fees | ⊘ | ⊘ | No conversion path. |
| **Q-01** | Should confidence affect valuation? | 📝 | 📝 | Acknowledged/intentional in V4; V1/V3 likewise exclude per-sample confidence by design. |
| **Q-02** | Overdue loans extendable? | ✅ | ✅ | `extend_loan` now refuses `now > due_timestamp`. **⚠️ Behavior change** — a late borrower can no longer extend; flagged for operator sign-off. |
| **Q-03** | Caller specifies collateral value? | ☑️ | ☑️ | Borrower-supplied `collateral_value` is checked against the pool-bound attested price within a tolerance (`MAX_VALUE_TOLERANCE_BPS`), and capped by it — the caller cannot set their own borrowing power. |
| **Q-04** | Armed slice cap per conversion | ⊘ | ⊘ | No conversion/arming. |

## Summary

- **Ported (5):** H-01, M-04, L-06, I-04, Q-02 — all compile-verified, matching audited V4.1.
- **Already covered, verified (9):** M-02, M-03, L-01(V3), L-03, L-05, L-07, I-01, I-03, Q-03.
- **Not applicable — no auto-sell/conversion engine (7):** H-02, L-04, L-08, I-05, I-06, Q-04, L-01(V1).
- **Documented design choice (3):** L-02 (off-chain recover), I-02 (emergency lever), Q-01 (intentional).
- **Operator decision (1):** M-01 — full mid-life health-recheck on extend (not a value-extraction vector; a UX change if added).

**Net: every one of the 24 findings is accounted for.** The only item awaiting a call is M-01
(a design choice, not an open vulnerability), plus the Q-02 UX sign-off.

## Collectibles (design-only)

Ported into the design before code exists: `magpie-collectibles-lending` **doc 45**. The
fixed-term, oracle-less, no-mid-loan-liquidation model neutralizes the oracle/TWAP/auto-sell
class by construction; the remaining lifecycle findings became build acceptance criteria.

## ⛔ Deploy gate

V1/V3 hold live user funds. This is reviewable code only. Any deploy ships at a **new program
id** (never same-id), requires a migration plan, and needs explicit operator go-ahead. Build and
test in each program's deploy environment before deploying.
