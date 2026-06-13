# Limit-Close Engine Architecture Audit

> **Audience:** operator + future engineers building on the limit-close engine
>
> **Goal:** map the engine's complete execution path, document every safety gate, and identify gaps before they become incidents. Operator escalated 2026-06-12: "we can't stop until the limit sale build for both the regular protocol and the x402 are PERFECTED. We need this to change the landscape of the entire space."
>
> **Status as of 2026-06-13:** Engine code is shipped; zero orders have fired in production yet. This doc identifies the validation work needed before declaring "perfected" and the architectural constraints worth understanding before users rely on it.

---

## 1. Execution path (happy path TP)

When a user arms `/takeprofit <loan> at 2x`:

1. **Arm-time** (`bagbank-bot/src/services/limit-close-arm-core.js`):
   - Loan ownership + state validation (active, ≥1 SOL, not RWA-mismatched)
   - Per-user concurrency cap (max 10 armed orders)
   - Pre-flight Jupiter quote at the EFFECTIVE max slippage cap
   - INSERT row into `limit_close_orders` with `status='armed'`, `trigger_direction='above'`
   - UNIQUE partial index on `(loan_id WHERE status='armed')` → physically impossible to double-arm

2. **Watch** (`magpie-limitclose/src/watcher.js`):
   - Tick every ~30s
   - For each armed order: pull current price via `getCurrentPrice` (Jupiter + DexScreener cross-sourced + Pyth for covered mints, post PR #111)
   - Call `isTriggerHit({trigger_kind, trigger_value_micro, trigger_direction, currentPrice})` — returns true if hit
   - On hit: `processArmedOrder(connection, order.id)`

3. **Fire** (`magpie-limitclose/src/execution.js processArmedOrder`):
   - DRY RUN check — exits early if `LIMIT_CLOSE_DRY_RUN=true`
   - **claim** — atomic UPDATE `status='armed' → status='firing'`. Race-safe.
   - **failure budget** — abort if `failure_count >= MAX_FAILURE_COUNT`
   - **load context** — `loadOrderContext(order)` joins loan + mint metadata
   - **pre-flight gates** — `runPreFlightGates({order, loan, mintRow})`
     - Order expiry
     - Loan still active
     - Mint still enabled
   - **trigger re-check** — re-fetch current price, re-evaluate `isTriggerHit` (direction-aware). Engine is the authoritative source of truth.
   - **proceeds sanity check** — Jupiter quote at the actual collateral amount, verify
     - `proceeds - fee - owed >= 0.005 SOL` for TP (safety margin)
     - `proceeds - fee - owed >= 0` for SL (just solvency; PR #7 to engine)
   - **slippage escalation if needed** — Layer A. Quote walks up to cap.
   - **TWAP feasibility check** — Layer 2. If single-block can't clear at cap, evaluate TWAP slicing. Refuse if TWAP also can't fit.
   - **borrower wallet validation** — wallet hasn't been switched since arm time
   - **SOL reserve preflight** — `ensureSolReserve` tops the user wallet to ~0.03 SOL for tx fees (`ENGINE_TOPUP_LAMPORTS`)
   - **EXECUTE REPAY** — `executeRepayViaBot` calls `on-chain-repay.js executeOnChainRepay`
     - Builds repay tx including `SystemProgram.transfer({from: borrower, to: borrowerWsolAta, lamports: owed})`
     - `createSyncNativeInstruction(borrowerWsolAta)` marks the SOL as wSOL
     - `program.methods.repayLoan()` burns the wSOL + releases collateral
     - `createCloseAccountInstruction` returns rent + leftover wSOL to borrower
   - **confirm released collateral** — re-read borrower's collateral ATA balance; abort if 0 (anomaly)
   - **EXECUTE SWAP** — re-quote at actual balance, build Jupiter swap tx, borrower signs, submit
   - **compute proceeds + fee + net** — `feeLamports = proceeds * protocol_fee_bps / 10000`
   - **TRANSFER FEE** — `transferFee()` sends `feeLamports` to `PROTOCOL_FEE_DESTINATION` (`4JSSSaG3...`)
   - **REPAY ENGINE TOPUP** — pull back the 0.03 SOL topup from the user wallet
   - **persist** — UPDATE `status='fired'`, record tx sigs + proceeds + fee + net to user
   - **enqueue notification** — DM the user

## 2. Architectural constraints

### 2.1 The borrower-must-hold-owed-SOL constraint (HIGH attention)

The repay step transfers `owed` lamports of **native SOL** from the borrower wallet into the wSOL ATA. The borrower MUST hold `owed` lamports in native SOL at fire time.

| Scenario | Wallet has owed SOL? | Outcome |
|---|---|---|
| TP at 2x, user kept the borrowed SOL | Yes | Fires cleanly |
| TP at 2x, user withdrew the borrowed SOL the same day | **NO** | Repay tx fails. Engine retries until failure budget. Order ends in `failed` state. |
| SL at -10%, user kept borrowed SOL | Yes | Fires (if proceeds cover) |
| SL at -10%, user withdrew | **NO** | Same failure mode |

**Mitigation today:**
1. PR #114 — arm-time solvency floor refuses SL arms where proceeds < owed × 1.05. Closes the SL-into-insolvency path.
2. Engine topup (0.03 SOL) — covers tx fees, NOT the owed amount.
3. There is currently **no engine-side check** that the borrower wallet holds `owed` SOL before attempting repay.

**Recommendation (P0):** Add an engine-side balance check before `executeOnChainRepay`. If borrower SOL balance < owed + 0.005 buffer, DM the user "Your wallet needs SOL to repay this loan — please send at least X SOL to <wallet> and try again, or cancel the order." Don't burn the failure budget on a deterministic failure.

**Long-term (P1):** Sell-first-then-repay pattern. The Anchor program would need a new ix `liquid_close` that:
1. Transfers collateral from `collateral_vault` to a fresh ATA
2. Returns control off-chain for the bot to swap via Jupiter
3. Bot returns with `actual_proceeds` of wSOL
4. Program uses `actual_proceeds` to repay (no `SystemProgram.transfer` needed)
5. Returns leftover wSOL to borrower as native SOL

This requires a V1 program redeploy at the SAME program ID, which the operator's `feedback_onchain_program_changes.md` rule explicitly forbids. The alternative: parallel program (V1.1) where new loans opt in. Multi-week effort.

### 2.2 The 1% protocol fee is direction-agnostic (verified safe)

`feeLamports = proceedsLamports * protocol_fee_bps / 10_000n` — same calculation for TP and SL. Verified in `magpie-limitclose/src/execution.js:676` and `:1075` (TWAP chunk).

### 2.3 Engine topup wallet must stay funded

`ENGINE_TOPUP_KEYPAIR` env var on the engine service. Pays 0.03 SOL per fire to top up users. Watcher should DM the operator when it runs low.

**Recommendation (P0):** Add a lender-balance-watcher equivalent for the engine topup wallet. Alert if balance < 5 SOL (= ~150 fires of headroom).

### 2.4 Multiple stop-loss directions need careful price oracle handling

The arm-time immediate-fire guard uses `getPriceInUsdCrossSourced` (PR #104 + #111). This now requires 2-of-3 sources for covered mints. **Good** — no path to arm against a manipulated single source.

The engine's `getCurrentPrice` (different code path) should ALSO use cross-sourced. Verify in `magpie-limitclose/src/pricing.js`.

## 3. Test coverage gaps

| Scenario | Tested? | How to test |
|---|---|---|
| TP fire end-to-end | NO (zero prod fires) | Operator arms a TP on a real $1 SOL loan; pump the trigger price |
| SL fire end-to-end | NO | Same as TP, with `/stoploss` |
| x402 agent path arm + fire | NO | x402 agent arms via the internal endpoint; manual price push |
| TWAP fallback | NO | Construct an order where single-block can't clear; verify TWAP slices |
| Layer 3 intervention DM | NO | Force a no-fit scenario; verify operator DM |
| Borrower wallet drained between arm + fire | NO | Drain wallet after arm; observe failure mode |
| Stop-loss safety floor exception (PR #7 engine side) | NO | Arm SL near solvency; trigger; verify it fires (not blocked by 0.005 SOL safety margin) |
| Failure budget exhaustion | NO | Force repeated repay failures; verify `failed` state + DM |
| Notification round-trip | NO | Trigger any fire; verify the user receives the success DM |

**Recommendation:** PR #115 (next tonight) — test fixture script.

## 4. Demo-readiness checklist

Before publishing a demo video:

- [ ] At least one TP fire executed live on mainnet (operator-controlled)
- [ ] At least one SL fire executed live (operator-controlled)
- [ ] At least one x402-agent-armed order executed
- [ ] `/lc-status` shows the fires correctly (PR #113)
- [ ] Operator received DM notifications for each fire
- [ ] Engine topup wallet balance alerts wired (P0 above)
- [ ] Engine-side borrower-balance pre-flight check shipped (P0 above)
- [ ] TWAP path validated on one real fire (forced)
- [ ] Failure mode handling validated (orphaned `firing` state recovery)
- [ ] Pyth third-source confirmed live for covered mints
- [ ] Demo script narrated against the actual fires, not mocks

## 5. Open questions for operator

1. **Test loan availability:** Can the operator arm a test SL on their own wallet (e.g., 1 SOL loan against $MAGPIE collateral) so the engine can be validated end-to-end?
2. **Operator alerts:** Where should fire success/failure DMs land? Same chat as `/admincmds` output? Separate operator-DM channel?
3. **Sell-first-then-repay roadmap:** Operator's call on whether to ship a V1.1 program parallel-deploy for that pattern, or accept the "borrower must hold owed SOL" constraint and educate users.
4. **Test fixture script (next PR):** would the operator prefer a fully-automated `npm run test:lc-fire` that arms + fires + asserts, or a manual checklist + helper scripts? Automated is more rigorous; manual is faster to ship.

---

**See also:**
- `F1_MULTISIG_MIGRATION_RUNBOOK.md` — pool authority migration
- `F7_LIQUIDATE_LOAN_VERIFICATION.md` — on-chain liquidation safety
- `magpie-limitclose/README.md` (private repo) — engine deployment notes
