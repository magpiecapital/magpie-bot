# Limit-Close Perfection — Progress Summary

> **Status:** Two waves shipped. Wave 1 (2026-06-12 → early 2026-06-13): 11 PRs, foundational observability + safety. Wave 2 (2026-06-13 evening): 18 additional PRs across 4 repos covering structural refactor, fire-time safety, x402 economics, agent preflight, user-facing polish, reliability backup generator, engine activity rollups. Demo-readiness criteria below.
>
> **Operator mandate** (2026-06-12 21:xx, reaffirmed 2026-06-13): "we can't stop until the limit sale build for both the regular protocol and the x402 are PERFECTED. We need this to change the landscape of the entire space." Followed by: "keep going. We need to work long and meticulously with the limit order setup for human + x402."

---

## 1. What "perfected" means in concrete terms

From `LIMIT_CLOSE_ENGINE_AUDIT.md` section 4, demo-readiness requires:

| Acceptance criterion | State | Closing PR(s) |
|---|---|---|
| At least one TP fire executed live on mainnet | ❌ Pending operator test | Use `scripts/test-lc-fire.mjs` (#119) |
| At least one SL fire executed live | ❌ Pending operator test | #114, #116, #8 unblock; test via #119 |
| At least one x402-agent-armed order executed | ❌ Pending agent integration | #121 + #131 + #134 (preflight) |
| `/lc-status` shows fires correctly | ✅ Shipped | #113 |
| `/lc-perf` historical analytics | ✅ Shipped | #127 (+ #136 engine-activity section) |
| Operator receives DM notifications for each fire | ✅ Shipped | #118 |
| Engine topup wallet balance alerts wired | ✅ Shipped | #117 |
| Engine-side borrower-balance pre-flight check | ✅ Shipped | #8 (engine) + #116 (renderer) |
| Engine watcher heartbeat alerts | ✅ Shipped | #9 (engine) + #120 (bot watcher + migration) |
| Engine startup self-test (degraded-boot detection) | ✅ Shipped | limit-close#10 + bot #126 |
| Engine "alive but degraded" status alerts (Jupiter probe) | ✅ Shipped | limit-close#11 + bot #132 |
| Cross-source price agreement at FIRE TIME | ✅ Shipped | limit-close#12 |
| Single source of truth for arm-time gates (TG/site/x402) | ✅ Shipped | bot #131 |
| Free preflight endpoint for agents (saves x402 fee on rejected arms) | ✅ Shipped | bot #134 + x402 #28 |
| Engine activity rollups (ticks/jup probes/fires per hour) | ✅ Shipped | bot #136 + limit-close#13 |
| Order staleness nudge for forgotten orders | ✅ Shipped | bot #133 |
| `/limitorders` enriched with TP/SL labels + distance + cancel buttons | ✅ Shipped | bot #135 |
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

## 2b. PRs shipped Wave 2 (2026-06-13 evening — 18 PRs across 4 repos)

> Continuation of the perfection sprint after the operator said "keep going. We need to work long and meticulously with the limit order setup for human + x402." Plus an unrelated outage (self-monitor.js duplicate declaration crashed the bot for ~10 min) that forced a defensive CI shipthrough.

### `magpie-bot` (12 PRs)

| # | Title | Purpose |
|---|---|---|
| [#125](https://github.com/magpiecapital/magpie-bot/pull/125) | borrow.js price-fail-soft + public `/api/v1/loan-tiers` | Generic "Something unexpected happened" → friendly retry; loan-tiers public endpoint for site consumption |
| [#126](https://github.com/magpiecapital/magpie-bot/pull/126) | `engine_preflight_failed` notification renderer | Operator DM when limit-close engine refuses to boot |
| [#127](https://github.com/magpiecapital/magpie-bot/pull/127) | `/lc-perf` admin analytics | Time-to-fire p50/p95, TP/SL breakdown, source breakdown, economic totals, failure top-5 |
| [#128](https://github.com/magpiecapital/magpie-bot/pull/128) | **HOTFIX** self-monitor.js duplicate declaration | PROD DOWN ~10 min; duplicate `probeCreditCoverage` crashed bot at boot |
| [#129](https://github.com/magpiecapital/magpie-bot/pull/129) | Pre-merge `node --check` CI + IMPERSONATION_PATTERNS gap close | Catches the bug class that took down #128; adds `\bpip\b`/`\bdev\b`/`\bfounder\b`/`\bowner\b` after live Pip impersonator |
| [#130](https://github.com/magpiecapital/magpie-bot/pull/130) | `/scan-impersonators` admin command | Retroactive sweep: getChatMember on recent joins, run isImpersonationName, DM hits with one-tap ban |
| [#131](https://github.com/magpiecapital/magpie-bot/pull/131) | **Agent endpoint → `armOrder()` refactor** | Eliminates structural drift: TG/site/x402 now share the same arm-time gate code path; +119 / −212 lines |
| [#132](https://github.com/magpiecapital/magpie-bot/pull/132) | Heartbeat watcher reads `last_tick_status` | Status-aware alerts: "Engine alive but Jupiter degraded" as distinct DM from "Engine silent" |
| [#133](https://github.com/magpiecapital/magpie-bot/pull/133) | Order-staleness DM nudge + migration 044 | Orders >7d old with trigger >30% away get a one-time "still relevant?" DM with [Keep active]/[Cancel] |
| [#134](https://github.com/magpiecapital/magpie-bot/pull/134) | **x402 agent preflight endpoint** | Free dry-run; agents save x402 fees on rejected arms; `armOrder` gained `dryRun` flag |
| [#135](https://github.com/magpiecapital/magpie-bot/pull/135) | `/limitorders` enriched | TP/SL pill, age, distance-to-trigger %, inline cancel buttons |
| [#136](https://github.com/magpiecapital/magpie-bot/pull/136) | `engine_metrics_hourly` migration + `/lc-perf` Engine activity section | Hourly rollups (ticks/jupiter probes/fires); `/lc-perf` no longer goes silent during quiet periods |

### `magpie-limitclose` (4 PRs)

| # | Title | Purpose |
|---|---|---|
| [#10](https://github.com/magpiecapital/magpie-limitclose/pull/10) | Engine preflight self-test | Refuses to start watcher on DB/RPC/Jupiter/keypair/required-table failure; operator DM |
| [#11](https://github.com/magpiecapital/magpie-limitclose/pull/11) | Per-tick Jupiter health probe | 5s-timeout quote each tick → `last_tick_status='jupiter_degraded'` after 2 misses |
| [#12](https://github.com/magpiecapital/magpie-limitclose/pull/12) | **Cross-source price agreement at fire time** | Jupiter + DexScreener required; disagree above 5% → defer fire; closes $FATHER-class attack |
| [#13](https://github.com/magpiecapital/magpie-limitclose/pull/13) | Per-tick metrics accumulator → `engine_metrics_hourly` | UPSERT counters into hour bucket; race-free `col = col + EXCLUDED.col` |

### `magpie-x402` (1 PR)

| # | Title | Purpose |
|---|---|---|
| [#28](https://github.com/magpiecapital/magpie-x402/pull/28) | Free preflight route | Forwards `POST /api/v1/agent/limit-close/preflight` to bot; no x402 charge |

### `magpie-site` (1 PR)

| # | Title | Purpose |
|---|---|---|
| [#51](https://github.com/magpiecapital/magpie-site/pull/51) | Dashboard fetches `/api/v1/loan-tiers` | Closes DB-drift hazard; dashboard + marketplace both source-of-truth-fetch |

### Outage retrospective (2026-06-13 04:22Z, ~10 min)

Duplicate `probeCreditCoverage` declaration in self-monitor.js crashed the bot at boot. Site uptime monitor caught + DMed operator. Hotfix in #128. Defense added in #129 (`node --check` CI now required on main). Memory entry: `project_magpie_outage_2026_06_13_self_monitor.md`. Backup-generator wiring (auto-restart via Railway redeploy on N consecutive health misses) shipped in magpie-site#53 — needs `RAILWAY_API_TOKEN` env vars on Vercel to activate.

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

### 3.2 ~~Agent endpoint duplicates arm-core logic~~ — RESOLVED 2026-06-13 (#131)

The agent endpoint (`src/api/internal-agent-limitclose.js`) now calls `armOrder()` directly. Single source of truth for arm-time gates across TG / site / x402. Any new safety check added to `armOrder()` propagates to all three surfaces automatically. The agent-specific bits (delegation lookup, BOUNDS check, per-agent concurrency, wallet binding) live at the endpoint; everything user-level delegates to `armOrder()`.

**Net effect today:** no more "add a gate in one place, forget to port it elsewhere" risk. Future safety gates ship once, apply everywhere.

### 3.3 Engine reliability stack (updated 2026-06-13)

| Failure mode | Detection | Recovery |
|---|---|---|
| Engine boot in degraded state (bad DB pw, wrong keypair, missing migration) | Preflight self-test (limit-close#10) → operator DM + exit 1 | Operator fixes env/migration; Railway restarts |
| Engine process dies | Heartbeat stale tiered alerts (#120) → operator DM at WARN/CRITICAL/EMERGENCY | Manual restart on Railway, **OR** auto-restart via site backup generator (magpie-site#53 — needs RAILWAY_API_TOKEN env vars) |
| Engine alive but Jupiter degraded | Per-tick Jupiter probe (limit-close#11) → `last_tick_status='jupiter_degraded'` → distinct operator DM (#132) | Engine retries automatically when probe recovers |
| Cross-source price disagreement at FIRE TIME | Gate at execution.js (limit-close#12) | Defer fire (revert to armed); next tick re-checks |
| Engine topup wallet drains | Tiered balance alerts (#117) | Manual top-up |
| Borrower wallet insufficient | Pre-check (#8) → soft revert + user DM | User tops up; engine retries next tick |
| Jupiter rate-limited (price reads) | Fail-closed gate + Pyth third source (#111) | Engine retries; Pyth fallback for covered mints |
| TWAP can't fit | Existing intervention DM | Layer 3 — user approves wider slippage |
| Order in `firing` state too long | Existing `recoverStuckFiring` | Engine reverts to armed |
| Bot itself goes down | Vercel cron uptime watchdog + auto-restart (magpie-site#53) | Auto-redeploy attempts (max 3 per outage, 10 min cooldown) — needs RAILWAY_API_TOKEN |
| Pip impersonator in TG group | Auto-detect on join via expanded IMPERSONATION_PATTERNS (#129); retroactive `/scan-impersonators` (#130) | Auto-ban; operator manual sweep available |

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

## 5. Open items / known gaps (refreshed 2026-06-13)

| Gap | Priority | Action |
|---|---|---|
| Live first TP fire validation | P0 | Operator runs the recipe in section 4 |
| Live first SL fire validation | P0 | Operator runs SL variant of section 4 |
| Live first x402-agent fire validation | P0 | Agent integration + preflight (now free via #134) |
| `RAILWAY_API_TOKEN` / `SERVICE_ID` / `ENVIRONMENT_ID` env vars on Vercel | P1 | One-time operator action — activates auto-restart backup generator (magpie-site#53) |
| Sell-first-then-repay pattern | P1 | Anchor program change; multi-week; covered in audit. Mitigated today by SL solvency floor (#114) + engine pre-check (#8) + user DM (#116) |
| TWAP path live validation | P2 | Will exercise during demo recording |
| Synthetic canary fire (periodic dry-run) | P2 | Foundation in place (engine has `LIMIT_CLOSE_DRY_RUN` env); needs marker column + watcher |
| `recoverStuckFiring` live exercise | P3 | Not yet hit in production; existing engine logic |
| ~~Agent endpoint → `armOrder()` refactor~~ | RESOLVED | #131 — single source of truth across surfaces |
| ~~Tier resolver wiring on simulate/unlock/community-pip~~ | RESOLVED | #123 |

---

## 6. Operator action queue (things ONLY the operator can do)

These are the items where engineering is done and the operator's hands are needed:

1. **Set Vercel env vars on `magpie-site` project:** `RAILWAY_API_TOKEN` (Workspace > Deploy scope), `RAILWAY_SERVICE_ID`, `RAILWAY_ENVIRONMENT_ID`. Without these the bot-watchdog cron still DMs on outages but skips the autonomous restart. Five-minute task.
2. **Arm the first live TP order** against an operator-owned loan. Section 4 has the recipe.
3. **Arm the first live SL order** against an operator-owned loan. Same recipe with `/stoploss`.
4. **Demo an x402 agent arm.** Use the new free `POST /api/v1/agent/limit-close/preflight` first to confirm the arm would succeed, then `POST /api/v1/agent/limit-close` for the real arm with x402 payment.
5. **Record the demo.** All instrumentation in place to narrate against actual fires: `/lc-status`, `/lc-perf`, `/lc-status armed/fired/failed`, `node scripts/test-lc-fire.mjs watch <order>`.

---

## 7. Demo video flow recommendation

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
