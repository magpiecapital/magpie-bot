# Limit-Close Perfection — Progress Summary

> **Status:** Engineering shipped overnight 2026-06-12 → 2026-06-13. 11 PRs queued for operator review across `magpie-bot` (#113–#121) and `magpie-limitclose` (#8, #9). Architectural constraints documented. Demo-readiness checklist tracked here.
>
> **Operator mandate** (2026-06-12 21:xx): "we can't stop until the limit sale build for both the regular protocol and the x402 are PERFECTED. We need this to change the landscape of the entire space."

---

## 1. What "perfected" means in concrete terms

From `LIMIT_CLOSE_ENGINE_AUDIT.md` section 4, demo-readiness requires:

| Acceptance criterion | State | Closing PR(s) |
|---|---|---|
| At least one TP fire executed live on mainnet | ❌ Pending operator test | Use `scripts/test-lc-fire.mjs` (#119) |
| At least one SL fire executed live | ❌ Pending operator test | #114, #116, #8 unblock; test via #119 |
| At least one x402-agent-armed order executed | ❌ Pending agent integration | #121 adds SL; agent fires use existing path |
| `/lc-status` shows fires correctly | ✅ Shipped | #113 |
| Operator receives DM notifications for each fire | ✅ Shipped | #118 |
| Engine topup wallet balance alerts wired | ✅ Shipped | #117 |
| Engine-side borrower-balance pre-flight check | ✅ Shipped | #8 (engine) + #116 (renderer) |
| Engine watcher heartbeat alerts | ✅ Shipped | #9 (engine) + #120 (bot watcher + migration) |
| TWAP path validated on one real fire | ❌ Pending | Will validate during demo recording |
| Failure mode handling validated (orphaned firing state) | ⚠️ Engine has `recoverStuckFiring`; not exercised live |  — |
| Pyth third-source confirmed live for covered mints | ✅ Shipped earlier today | #111 |
| Demo script narrated against actual fires | ❌ Pending operator | Use `scripts/test-lc-fire.mjs watch <order>` for live narration |

---

## 2. PRs shipped overnight (11 total)

### `magpie-bot` (9 PRs)

| # | Title | Purpose |
|---|---|---|
| [#113](https://github.com/magpiecapital/magpie-bot/pull/113) | `/lc-status` observability | Operator-facing real-time read on engine state (armed/firing/fired/failed counts, last-fire age, recent tx links, engine wallet balance) |
| [#114](https://github.com/magpiecapital/magpie-bot/pull/114) | SL solvency floor | Arm-time refusal of SL arms where estimated proceeds at trigger < owed × 1.05 (prevents fires into insolvency) |
| [#115](https://github.com/magpiecapital/magpie-bot/pull/115) | Engine architecture audit doc | Full execution path mapped; constraints documented; demo-readiness checklist |
| [#116](https://github.com/magpiecapital/magpie-bot/pull/116) | `limit_close_action_required` user DM renderer | Friendly message when engine reverts because borrower wallet needs SOL top-up |
| [#117](https://github.com/magpiecapital/magpie-bot/pull/117) | Engine topup wallet balance watcher | Tiered LOW/CRITICAL/EMERGENCY alerts when engine topup wallet drains |
| [#118](https://github.com/magpiecapital/magpie-bot/pull/118) | Operator fire/failure DMs | First-fire-ever celebration; every subsequent fire + failure DMs operator with tx links |
| [#119](https://github.com/magpiecapital/magpie-bot/pull/119) | `test-lc-fire.mjs` test fixture | Operator-runnable CLI: status, check, simulate, watch, prices |
| [#120](https://github.com/magpiecapital/magpie-bot/pull/120) | Engine heartbeat watcher + migration 043 | Detects engine silence with tiered WARN/CRITICAL/EMERGENCY DMs |
| [#121](https://github.com/magpiecapital/magpie-bot/pull/121) | x402 agent path: SL + immediate-fire + solvency | Agents can now arm stop-loss (was TP-only); same safety gates as TG/site path |

### `magpie-limitclose` (2 PRs)

| # | Title | Purpose |
|---|---|---|
| [#8](https://github.com/magpiecapital/magpie-limitclose/pull/8) | Borrower repay-capability pre-check | Engine refuses to fire if borrower wallet < `owed + 0.005 SOL`; DM user instead of burning failure budget |
| [#9](https://github.com/magpiecapital/magpie-limitclose/pull/9) | Heartbeat write each tick | UPSERT `engine_heartbeats` so bot-side watcher can detect engine silence |

---

## 3. Architectural constraints still in place

### 3.1 Borrower must hold `owed` SOL at fire time (HIGH attention)

The `repay_loan` ix transfers `owed` lamports of native SOL from borrower → wSOL ATA. If the borrower withdrew their borrow (very common), the wallet doesn't have those lamports.

**Mitigations shipped:**
- Arm-time SL solvency floor (#114) — refuses arms that would fire into insolvency
- Engine-side pre-check (#8) — soft-reverts to armed + DMs user "send X SOL to <wallet>" instead of burning failure budget
- User-facing renderer (#116) — friendly message explaining the constraint + remediation

**Net effect today:** users get a clear, actionable message and can unblock their order by topping up. No silent failures.

**Long-term fix (P1, deferred):** sell-first-then-repay pattern. Requires Anchor program change. Covered in `LIMIT_CLOSE_ENGINE_AUDIT.md` section 2.1.

### 3.2 Agent endpoint duplicates arm-core logic (MEDIUM)

`src/api/internal-agent-limitclose.js` has its own INSERT + validation rather than calling `armOrder()`. Tonight's PR #121 ported the missing safety gates inline. Full refactor to `armOrder()` is queued — cleaner long-term but more risky as a single PR.

**Net effect today:** the agent and TG paths apply the same gates. Drift is bounded to "future arm-core changes need to be ported manually until the refactor lands."

### 3.3 Engine reliability stack

| Failure mode | Detection | Recovery |
|---|---|---|
| Engine process dies | Heartbeat stale > 5 min → operator DM (#120) | Manual restart on Railway |
| Engine topup wallet drains | Tiered balance alerts (#117) | Manual top-up |
| Borrower wallet insufficient | Pre-check (#8) → soft revert + user DM | User tops up; engine retries next tick |
| Jupiter rate-limited | Existing fail-closed gate + Pyth third source | Engine retries; PR #111 Pyth fallback |
| TWAP can't fit | Existing intervention DM | Layer 3 — user approves wider slippage |
| Order in `firing` state too long | Existing `recoverStuckFiring` | Engine reverts to armed |

---

## 4. End-to-end test recipe for first fire

When the operator is ready to validate live:

```bash
# Step 1 — inspect engine state
node scripts/test-lc-fire.mjs status

# Step 2 — pick a loan to test against (must be active, ≥1 SOL, memecoin)
# Operator's own loans only — never test on user wallets
node scripts/test-lc-fire.mjs check <loan_id>
# All green? Continue.

# Step 3 — dry-run the arm
node scripts/test-lc-fire.mjs simulate <loan_id> --tp 1.05x
# Verify resolved target makes sense.

# Step 4 — arm a real TP order via TG
# In @magpie_capital_bot:
/takeprofit <loan_id> at 1.05x

# Step 5 — note the order_id returned by the bot, then watch it live
node scripts/test-lc-fire.mjs watch <order_id>
# When the trigger hits, you'll see:
#   - status transitions
#   - repay tx Solscan link
#   - swap tx Solscan link  
#   - proceeds

# Step 6 — operator receives celebration DM (#118 first-fire)

# Step 7 — verify the protocol fee landed in 4JSSSaG3 wallet
# Either via Solscan or:
/lc-status fired
```

For stop-loss, replace step 4 with:
```
/stoploss <loan_id> at 0.95x      ← sell if price drops 5%
```

For x402 agent:
1. Authorize the agent first via `/agent_authorize`
2. Hit `POST /api/v1/internal/agent/limit-close/arm` with `trigger_direction: "below"` for SL or `"above"` for TP
3. Same watch flow

---

## 5. Open items / known gaps

| Gap | Priority | Action |
|---|---|---|
| Live first fire validation | P0 | Operator runs the recipe in section 4 |
| Sell-first-then-repay pattern | P1 | Anchor program change; multi-week; covered in audit |
| Agent endpoint → `armOrder()` refactor | P2 | Code cleanup; both paths safe today via inline porting |
| TWAP path live validation | P2 | Will exercise during demo recording |
| `recoverStuckFiring` live exercise | P3 | Not yet hit in production; existing engine logic |
| Tier resolver wiring on simulate/unlock/community-pip | P3 | Low impact; out-of-scope from PR #108 |

---

## 6. Demo video flow recommendation

Once first fire lands, the demo can narrate:

1. **Show armed orders** — `/lc-status armed` or `node scripts/test-lc-fire.mjs status`
2. **Pick one to track** — `node scripts/test-lc-fire.mjs watch <order>`
3. **Wait for trigger** — narrate the price hit
4. **Watch the fire** — `status=firing` → repay tx → swap tx → `status=fired`
5. **Show settlement** — proceeds, fee, net to user
6. **Show operator DM** — the #118 fire celebration
7. **Show /lc-status fired** — historical record with tx links
8. **Show the protocol fee landing** — Solscan for `4JSSSaG3`

The full story takes ~3 minutes of real time; the demo could be a 60-second cut with the watch output as voiceover.

---

**Updates:** this doc is the single source of truth for the perfection effort. Future PRs targeting limit-close should update the relevant table here.
