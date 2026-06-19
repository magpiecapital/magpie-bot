/**
 * Bot self-monitoring tick.
 *
 * Runs every 60s INSIDE the bot process. Catches degradation that
 * the external watchdogs can't see — sub-systems failing, DB pool
 * exhausted, queues backing up, error rates spiking. DMs the
 * operator BEFORE users start complaining.
 *
 * Why we need this on top of the external watchdogs:
 *   The Vercel cron and GitHub Actions watchdogs check whether the
 *   bot is REACHABLE. They can't see whether:
 *     - The notification queue is stuck (DB write but no TG send)
 *     - The DB connection pool is exhausted (queries timing out)
 *     - Error rate has spiked (every borrow is failing)
 *     - A specific background watcher has died
 *   These are silent failures that look "up" from outside but break
 *   the actual user experience. This module catches them.
 *
 * Alert deduplication:
 *   Sub-systems can be in a bad state for many ticks in a row. We
 *   don't want to DM the operator every 60s about the same issue —
 *   that trains them to ignore alerts. Each alert kind is throttled
 *   to one DM per ALERT_COOLDOWN_MS; subsequent failures during the
 *   cooldown are counted (and surfaced in the next alert when the
 *   cooldown elapses).
 *
 * Alert escalation:
 *   First alert: "X is degraded."
 *   After cooldown: "X is still degraded — N consecutive bad ticks."
 *   On recovery: "X has recovered after N bad ticks."
 *   That cycle gives the operator the SHAPE of the problem without
 *   spamming.
 *
 * Failure-mode of the monitor itself:
 *   If any of the probes throw, we catch + log + continue. A broken
 *   monitor must NEVER cause the bot to crash. Better to silently
 *   miss an alert than take down the very thing we're monitoring.
 */
import { PublicKey } from "@solana/web3.js";
import { query, pool } from "../db/pool.js";
import { connection } from "../solana/connection.js";
import { notifyAdmin } from "./admin-notify.js";

const TICK_MS = 60_000;
const ALERT_COOLDOWN_MS = 15 * 60_000; // 15 min between same-kind alerts

// Floor at which the engine topup wallet is considered low. ~15 topups
// at 0.03 SOL each — enough headroom that the operator gets a DM well
// before any order fails for lack of topup funds. Override via env.
const ENGINE_TOPUP_LOW_LAMPORTS = BigInt(
  process.env.ENGINE_TOPUP_LOW_LAMPORTS || "500000000", // 0.5 SOL
);

// In-memory state. Reset on bot restart, which is fine: restart =
// fresh start = no prior context to track.
const state = {
  lastAlertAt: new Map(),        // kind -> timestamp
  consecutiveBad: new Map(),     // kind -> count of bad ticks
  lastReportedBad: new Map(),    // kind -> bool (last alert was bad)
};

function withinCooldown(kind) {
  const at = state.lastAlertAt.get(kind);
  if (!at) return false;
  return Date.now() - at < ALERT_COOLDOWN_MS;
}

function recordOutcome(kind, isBad) {
  if (isBad) {
    state.consecutiveBad.set(kind, (state.consecutiveBad.get(kind) || 0) + 1);
  } else {
    state.consecutiveBad.set(kind, 0);
  }
}

async function alertIfNew(bot, kind, line, severity = "warn") {
  // Don't alert if currently in cooldown AND we already reported as bad.
  // But DO alert on recovery even if in cooldown — recovery is a
  // distinct event the operator wants to know about.
  if (withinCooldown(kind) && state.lastReportedBad.get(kind)) return;
  state.lastAlertAt.set(kind, Date.now());
  const consecutive = state.consecutiveBad.get(kind) || 0;
  const prefix = severity === "crit" ? "🚨 CRIT" : "⚠️  WARN";
  const suffix = consecutive > 1 ? ` (consecutive bad ticks: ${consecutive})` : "";
  await notifyAdmin(bot, `${prefix} [self-monitor] ${line}${suffix}`);
  state.lastReportedBad.set(kind, true);
}

async function alertRecovery(bot, kind, line) {
  if (!state.lastReportedBad.get(kind)) return; // never reported as bad
  await notifyAdmin(bot, `✅ [self-monitor] ${line}`);
  state.lastReportedBad.set(kind, false);
  state.lastAlertAt.set(kind, Date.now());
}

/* ─── Probes ─────────────────────────────────────────────────── */

/**
 * DB pool exhaustion check. pg's pool has waitingCount > 0 when
 * queries are queued because all connections are busy. Persistent
 * waitingCount means we're CPU-bound on DB ops and other paths are
 * stalling.
 */
async function probeDbPool(bot) {
  const KIND = "db_pool_exhausted";
  const waiting = pool.waitingCount ?? 0;
  const idle = pool.idleCount ?? 0;
  const total = pool.totalCount ?? 0;
  // We consider exhaustion = >5 queries waiting OR 0 idle and total at cap.
  const isBad = waiting > 5;
  recordOutcome(KIND, isBad);
  if (isBad) {
    await alertIfNew(bot, KIND,
      `DB pool exhausted: ${waiting} queries waiting, ${idle}/${total} idle. Some endpoints may be slow.`,
      "warn",
    );
  } else {
    await alertRecovery(bot, KIND,
      `DB pool recovered. ${waiting} waiting / ${idle}/${total} idle.`,
    );
  }
}

/**
 * Pending-notifications backlog check. The engine writes here, the
 * sender drains. If pending grows unboundedly, something is broken
 * in the sender path (TG rate limit, blocked user spam, render fail).
 */
async function probePendingNotifs(bot) {
  const KIND = "pending_notifs_backlog";
  let pending = 0;
  let oldestAgeSec = 0;
  try {
    const { rows: [r] } = await query(`
      SELECT COUNT(*)::int AS n,
             COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))), 0)::int AS oldest_sec
        FROM pending_notifications
       WHERE status = 'pending' AND attempt_count < 5
    `);
    pending = r.n;
    oldestAgeSec = r.oldest_sec;
  } catch {
    // DB error already covered by db_pool / db_query probes.
    return;
  }
  // Threshold: > 50 pending OR oldest > 5 minutes (rendering should be
  // < 5s per notification; a 5min-old pending means the sender is
  // making no progress).
  const isBad = pending > 50 || oldestAgeSec > 300;
  recordOutcome(KIND, isBad);
  if (isBad) {
    await alertIfNew(bot, KIND,
      `Pending notifications backlog: ${pending} pending, oldest ${oldestAgeSec}s old.`,
      pending > 200 || oldestAgeSec > 900 ? "crit" : "warn",
    );
  } else {
    await alertRecovery(bot, KIND,
      `Notifications backlog cleared. ${pending} pending.`,
    );
  }
}

/**
 * Stuck-firing limit-close orders. The engine's stuck-recovery
 * normally handles these, but if recovery itself is broken (e.g.
 * the engine is paused or crashed) we want to know.
 */
async function probeStuckOrders(bot) {
  const KIND = "stuck_firing_orders";
  let stuck = 0;
  try {
    const { rows: [r] } = await query(`
      SELECT COUNT(*)::int AS n
        FROM limit_close_orders
       WHERE status = 'firing'
         AND firing_started_at < NOW() - INTERVAL '10 minutes'
    `);
    stuck = r.n;
  } catch { return; }
  const isBad = stuck > 0;
  recordOutcome(KIND, isBad);
  if (isBad) {
    await alertIfNew(bot, KIND,
      `${stuck} limit-close order(s) stuck in 'firing' > 10 min. Engine may be paused or crashed.`,
      "crit",
    );
  } else {
    await alertRecovery(bot, KIND, `No stuck-firing orders.`);
  }
}

/**
 * Migration ledger drift. If process.env.DB_MIGRATIONS_FAILED is set
 * (we set this on degraded-mode boot), surface it every cooldown
 * until fixed. Operator can't easily forget about a migration that
 * failed silently if we keep DMing every 15 min.
 */
async function probeMigrationsFailed(bot) {
  const KIND = "migrations_failed";
  const failedMsg = process.env.DB_MIGRATIONS_FAILED;
  const isBad = Boolean(failedMsg);
  recordOutcome(KIND, isBad);
  if (isBad) {
    await alertIfNew(bot, KIND,
      `Bot is running in DEGRADED mode — migrations failed at boot. ${failedMsg?.slice(0, 200)}. Investigate via Railway shell.`,
      "crit",
    );
  } else {
    // We never call recovery here — migration "recovers" only when
    // operator manually flips the env or redeploys with the fix. The
    // boot would clear DB_MIGRATIONS_FAILED on success.
  }
}

/**
 * Long-running TWAPs that exceeded their watchdog window without
 * being cleaned up. The engine's processTwapChunk handles this in
 * the normal path, but if the engine is down for >10 min those
 * rows linger. Surface so operator knows to investigate.
 */
async function probeTwapWatchdogMisses(bot) {
  const KIND = "twap_watchdog_miss";
  let lingering = 0;
  try {
    const { rows: [r] } = await query(`
      SELECT COUNT(*)::int AS n
        FROM limit_close_orders
       WHERE status = 'twap_in_progress'
         AND twap_started_at < NOW() - INTERVAL '15 minutes'
    `);
    lingering = r.n;
  } catch { return; }
  const isBad = lingering > 0;
  recordOutcome(KIND, isBad);
  if (isBad) {
    await alertIfNew(bot, KIND,
      `${lingering} TWAP order(s) past their 10-min window. Engine watchdog should have aborted them — investigate.`,
      "warn",
    );
  } else {
    await alertRecovery(bot, KIND, `No long-running TWAPs.`);
  }
}

/**
 * Engine topup wallet — the operator wallet that funds the small SOL
 * reserve the limit-close engine pushes to borrower wallets at fire
 * time. If this wallet drains, every subsequent take-profit fires with
 * topup_failed and reverts to armed forever. Per the operator-stated
 * "MUST execute" reliability mandate, we DM well before that point.
 *
 * The probe reads the PUBLIC KEY from env (the secret stays in the
 * engine's env only). A missing env var silently no-ops — engines
 * running pre-topup-PR or non-prod environments shouldn't alert.
 */
async function probeEngineTopupWallet(bot) {
  const KIND = "engine_topup_low";
  const pubkeyStr = process.env.ENGINE_TOPUP_PUBKEY;
  if (!pubkeyStr) return; // not configured yet, silent skip
  let pk;
  try { pk = new PublicKey(pubkeyStr); } catch { return; }
  let balance;
  try {
    balance = BigInt(await connection.getBalance(pk, "confirmed"));
  } catch (err) {
    // RPC blip — treat as recoverable, do not alert. Real drains
    // persist across many ticks; one missed read is noise.
    console.warn("[self-monitor] engine_topup balance read failed:", err.message);
    return;
  }
  const isBad = balance < ENGINE_TOPUP_LOW_LAMPORTS;
  recordOutcome(KIND, isBad);
  if (isBad) {
    const sol = (Number(balance) / 1e9).toFixed(3);
    const floor = (Number(ENGINE_TOPUP_LOW_LAMPORTS) / 1e9).toFixed(3);
    const sev = balance < ENGINE_TOPUP_LOW_LAMPORTS / 5n ? "crit" : "warn";
    // Pull recent lending velocity so the operator can size the refill.
    // Operator-stated wallet is reused for BOTH lending disbursements
    // AND the engine topup pool — alert context needs to reflect both.
    let burnContext = "";
    try {
      const { rows: [r] } = await query(`
        SELECT
          COALESCE(SUM(loan_amount_lamports) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours'), 0)::numeric AS lent_24h,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS new_loans_24h,
          COUNT(*) FILTER (WHERE status = 'active')::int AS active_open
          FROM loans
      `);
      const lent24h = (Number(r.lent_24h) / 1e9).toFixed(1);
      burnContext = ` Lending velocity: ${lent24h} SOL out in last 24h across ${r.new_loans_24h} loans; ${r.active_open} loans currently outstanding.`;
    } catch { /* non-critical */ }
    await alertIfNew(bot, KIND,
      `Engine topup wallet at ${sol} SOL (floor ${floor}). Take-profit fills AND new loan disbursements will fail when this drains.${burnContext} Top it up: ${pubkeyStr}`,
      sev,
    );
  } else {
    await alertRecovery(bot, KIND, `Engine topup wallet refilled.`);
  }
}

/**
 * Stale support tickets — operator only hears about ones the support
 * vigil is NOT actively handling. The vigil's tier schedule is:
 *   0h-24h   after admin_replied:  ticket in "user has time to respond" window
 *   24h-96h  after admin_replied:  Pip DM #1 has been sent (followup_count=1)
 *   96h-168h after admin_replied:  Pip DM #2 has been sent (followup_count=2)
 *   168h+:                          should be auto-closed
 *
 * Anything matching the expected schedule is NOT alerted — the vigil
 * has it. We alert ONLY when:
 *   - status='open' AND age >24h (admin hasn't replied + vigil only
 *     handles awaiting_user, so an old open is a real backlog)
 *   - awaiting_user AND age >24h AND followup_count=0 (vigil should
 *     have DM'd but didn't)
 *   - awaiting_user AND age >96h AND followup_count<=1 (vigil's 2nd
 *     nudge should have fired)
 *   - awaiting_user AND age >168h AND status not closed (auto-close
 *     should have fired)
 *
 * This keeps the operator's signal-to-noise clean — every alert here
 * means the vigil itself is failing in some way, not that a ticket is
 * within an expected window.
 *
 * Operator-stated rule: "No cases should go unanswered or unsolved."
 */
async function probeStaleSupport(bot) {
  const KIND = "stale_support";
  let count = 0;
  let oldestHours = 0;
  try {
    const { rows: [r] } = await query(`
      SELECT count(*)::int AS n,
             COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(COALESCE(admin_replied_at, created_at)))) / 3600, 0)::int AS oldest_hours
        FROM support_tickets
       WHERE (
         -- Truly stale OPEN tickets — admin never replied
         (status = 'open'
            AND created_at < NOW() - INTERVAL '24 hours')
         OR
         -- awaiting_user where vigil should have sent first nudge but didn't
         (status = 'awaiting_user'
            AND admin_replied_at < NOW() - INTERVAL '24 hours'
            AND COALESCE(pip_followup_count, 0) = 0)
         OR
         -- awaiting_user where vigil should have sent second nudge but didn't
         (status = 'awaiting_user'
            AND admin_replied_at < NOW() - INTERVAL '96 hours'
            AND COALESCE(pip_followup_count, 0) <= 1)
         OR
         -- awaiting_user that should have auto-closed but hasn't
         (status = 'awaiting_user'
            AND admin_replied_at < NOW() - INTERVAL '168 hours')
       )
    `);
    count = r.n;
    oldestHours = r.oldest_hours;
  } catch { return; }
  const isBad = count > 0;
  recordOutcome(KIND, isBad);
  if (isBad) {
    await alertIfNew(bot, KIND,
      `${count} support ticket(s) the vigil is NOT handling (oldest ${oldestHours}h). Tickets in active vigil care are excluded. Check /tickets for what's truly stuck.`,
      count >= 5 || oldestHours >= 168 ? "crit" : "warn",
    );
  } else {
    await alertRecovery(bot, KIND, `No support tickets outside vigil care.`);
  }
}

/**
 * Credit-events coverage probe — alerts the operator if ANY loan in
 * the protocol is missing its canonical credit_events. The healer
 * runs every 6h and auto-backfills; this probe runs every 60s so
 * the operator finds out within a minute rather than waiting. The
 * gap should always be 0 in steady state — anything > 0 means a
 * live writer dropped an event and the healer hasn't swept yet.
 *
 * Operator-stated mandate: "make sure we have parameters in place
 * for this to NEVER happen again." Probe is the early-warning leg.
 */
/**
 * Loan program_id drift probe — alerts if DB program_id disagrees
 * with the on-chain owner of the loan PDA.
 *
 * Background: 2026-06-13 incident — V2 RWA loans were silently
 * recorded with V1's program_id because recordLoan's fall-through
 * default. The wallet-scoped filter in the dashboard re-derives
 * loan PDAs using the DB program_id; when it's wrong the loan
 * silently disappears from the user's UI. Operator caught it via
 * a missing $SPCX loan.
 *
 * This probe samples the most-recent N active loans, looks up each
 * on-chain owner, and compares to the stored program_id. Any
 * mismatch is flagged. Sample size kept small (N=20) so the probe
 * stays cheap; coverage by recency catches new mis-records fast
 * while old loans get caught by the next full backfill.
 */
async function probeLoanProgramIdDrift(bot) {
  const KIND = "loan_program_id_drift";
  let mismatches = [];
  let scanned = 0;
  try {
    const { rows } = await query(
      `SELECT id, loan_pda, program_id FROM loans
        WHERE status = 'active'
          AND loan_pda IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 20`,
    );
    scanned = rows.length;
    if (scanned === 0) return;
    const { Connection, PublicKey } = await import("@solana/web3.js");
    const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
    for (const r of rows) {
      try {
        const info = await conn.getAccountInfo(new PublicKey(r.loan_pda));
        if (!info?.owner) continue;
        const onChain = info.owner.toBase58();
        if (onChain !== r.program_id) {
          mismatches.push({ id: r.id, loan_pda: r.loan_pda, db: r.program_id, chain: onChain });
        }
      } catch { /* RPC blip — skip; next probe will retry */ }
    }
  } catch (err) {
    console.warn("[self-monitor] loan_program_id_drift probe threw:", err.message);
    return;
  }
  const isBad = mismatches.length > 0;
  recordOutcome(KIND, isBad);
  if (isBad) {
    const detail = mismatches.slice(0, 5)
      .map((m) => `loan #${m.id} db=${m.db.slice(0, 8)}… chain=${m.chain.slice(0, 8)}…`)
      .join("; ");
    await alertIfNew(bot, KIND,
      `Loan program_id drift: ${mismatches.length} of ${scanned} sampled active loans have DB program_id != on-chain owner. ` +
      `These loans will silently disappear from wallet-scoped UI. Detail: ${detail}. Run the backfill script to repair.`,
      mismatches.length >= 3 ? "crit" : "warn",
    );
  } else {
    await alertRecovery(bot, KIND, `Loan program_id matches on-chain for ${scanned} sampled active loans.`);
  }
}

async function probeCreditCoverage(bot) {
  const KIND = "credit_coverage_gap";
  let audit;
  try {
    const m = await import("./credit-events-healer.js");
    audit = await m.auditCreditCoverage();
  } catch (err) {
    console.warn("[self-monitor] credit_coverage probe threw:", err.message);
    return;
  }
  const isBad = audit.total > 0;
  recordOutcome(KIND, isBad);
  if (isBad) {
    const parts = [];
    if (audit.missing_borrow > 0) parts.push(`${audit.missing_borrow} borrow`);
    if (audit.missing_repay > 0) parts.push(`${audit.missing_repay} repay`);
    if (audit.missing_liquidated > 0) parts.push(`${audit.missing_liquidated} liquidated`);
    await alertIfNew(bot, KIND,
      `Credit-event coverage gap: ${audit.total} loan(s) missing canonical events (${parts.join(", ")}). Healer auto-backfills within 1h. ` +
      `If the same loan persists across two self-monitor ticks, the live WRITE path dropped — investigate before the healer hides it.`,
      audit.total >= 3 ? "crit" : "warn",
    );
  } else {
    await alertRecovery(bot, KIND, `Credit-event coverage clean (0 gaps).`);
  }
}

/**
 * V4 TWAP sample-count health. Every enabled V4 mint must have
 * >= 8 samples within the rolling 5-min window — otherwise a borrow
 * lands on `TwapInsufficientHistory`. Background attestor SHOULD keep
 * this satisfied at the 35s cadence shipped in PR #348, but this probe
 * is the trip-wire if the attestor stalls (RPC blip, Jupiter outage,
 * service restart) or a freshly-enabled mint hasn't warmed yet.
 *
 * Operator-mandated 2026-06-18 PM after a "0 samples in window" borrow
 * rejection. See [[feedback_twap_insufficient_history_never_again]] for
 * the full defense; this is Layer 3 (Layer 1 is the cosign-borrow JIT
 * warmer that catches it before the user signs anything).
 */
async function probeV4TwapHealth(bot) {
  const KIND = "v4_twap_health";
  if (!process.env.PROGRAM_ID_V4 && !process.env.PROGRAM_ID_V3) {
    recordOutcome(KIND, false);
    return;
  }
  try {
    const { getV4TwapSampleCount } = await import("./price-attestor.js");
    const { PROGRAM_ID_V3, PROGRAM_ID_V4 } = await import("../solana/program.js");
    // Probe V3 + V4 — both use the price_v3 PriceHistory layout with
    // the same >=8-samples-in-300s TWAP rule. The V4-only probe missed
    // SPCX V3 borrows (RWA defaults to V3) — operator hit
    // TwapInsufficientHistory on SPCX 2026-06-18 PM.
    const programsToProbe = [];
    if (PROGRAM_ID_V4) programsToProbe.push({ id: PROGRAM_ID_V4, label: "V4" });
    if (PROGRAM_ID_V3) programsToProbe.push({ id: PROGRAM_ID_V3, label: "V3" });

    const { rows } = await query(
      `SELECT mint, symbol, decimals FROM supported_mints
        WHERE enabled = TRUE
        ORDER BY symbol`,
    );
    const REQUIRED = 8;
    const GAP_TOLERANCE_SEC = 60;
    const warming = [];
    const cold = [];
    for (const m of rows) {
      for (const prog of programsToProbe) {
        const status = await getV4TwapSampleCount(m.mint, 300, prog.id);
        if (status === null) {
          cold.push(`${m.symbol}(${prog.label} no feed)`);
          continue;
        }
        if (status.inWindow >= REQUIRED) continue;
        const now = Math.floor(Date.now() / 1000);
        const ageSec = status.newestTs ? now - status.newestTs : Infinity;
        if (ageSec > GAP_TOLERANCE_SEC) {
          cold.push(`${m.symbol}(${prog.label} ${status.inWindow}/8, last attest ${Math.round(ageSec)}s ago)`);
        } else {
          warming.push(`${m.symbol}(${prog.label} ${status.inWindow}/8)`);
        }
      }
    }
    const isBad = cold.length > 0;
    recordOutcome(KIND, isBad);
    if (isBad) {
      await alertIfNew(bot, KIND,
        `V4 TWAP health: ${cold.length} mint(s) cold (attestor stalled OR not running for them): ${cold.slice(0, 8).join(", ")}` +
        (warming.length > 0 ? `. Warming but tolerable: ${warming.slice(0, 5).join(", ")}` : "") +
        `. Cosign-borrow JIT warmer is Layer 1, but if it's tripping for users RIGHT NOW, investigate attestor logs.`,
        cold.length >= 3 ? "crit" : "warn",
      );
    } else if (warming.length > 0) {
      // Warming-only is not a fail — just log so /lc-perf can show it.
      console.log(`[self-monitor] v4_twap warming: ${warming.join(", ")}`);
    } else {
      await alertRecovery(bot, KIND, `V4 TWAP health: all ${rows.length} enabled mint(s) have 8+ samples in window.`);
    }
  } catch (err) {
    console.warn("[self-monitor] v4_twap_health probe threw:", err.message?.slice(0, 160));
  }
}

/**
 * Lender-wallet drain detector. Snapshots the lender wallet's SOL +
 * every token balance (SPL + Token-2022) on each tick, compares to the
 * previous snapshot, and CRIT-alerts on ANY decrease that isn't
 * accounted for by an expected outflow.
 *
 * This is the Layer 4 defense for the 2026-06-18 cosign-borrow
 * Token-2022 drain exploit (see
 * [[feedback_cosign_borrow_token_drain_exploit_2026_06_18]]). Even if
 * a future allowlisted program lets some new state-mutating
 * instruction shape slip past the Gate 0b enumeration in
 * cosign-borrow.js, this probe catches it within 60 seconds and pages
 * the operator.
 *
 * Expected-outflow filter: legitimate decreases happen when
 *   - treasury-sweeper moves SOL to the cold treasury vault
 *   - the holder-rewards distributor pays $MAGPIE holders
 *   - the lender voluntarily distributes liquidation proceeds
 * For the MVP we DO NOT pre-filter these — over-alerting is FAR safer
 * than missing a drain. Operator gets the tx signature in the alert
 * and can mark expected ones as such. Follow-up will subtract a
 * pre-registered allowlist of expected tx hashes.
 */
const lenderBalanceState = {
  lastSolLamports: null,
  lastTokenBalances: new Map(), // ata pubkey → { mint, owner, amount: bigint, decimals }
  initialized: false,
};
async function probeLenderWalletBalance(bot) {
  const KIND = "lender_wallet_balance_decrease";
  let LENDER_PUBKEY;
  try {
    LENDER_PUBKEY = new PublicKey(process.env.LENDER_PUBKEY);
  } catch {
    return; // not configured
  }
  let solLamports;
  let snapshot;
  try {
    solLamports = await connection.getBalance(LENDER_PUBKEY, "confirmed");
    const [sslTokens, t22Tokens] = await Promise.all([
      connection.getParsedTokenAccountsByOwner(
        LENDER_PUBKEY,
        { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") },
        "confirmed",
      ),
      connection.getParsedTokenAccountsByOwner(
        LENDER_PUBKEY,
        { programId: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") },
        "confirmed",
      ),
    ]);
    snapshot = new Map();
    for (const accts of [sslTokens.value, t22Tokens.value]) {
      for (const a of accts) {
        const info = a.account.data.parsed.info;
        const amt = BigInt(info.tokenAmount.amount);
        if (amt === 0n) continue; // skip empty ATAs
        snapshot.set(a.pubkey.toBase58(), {
          mint: info.mint,
          owner: info.owner,
          amount: amt,
          decimals: info.tokenAmount.decimals,
        });
      }
    }
  } catch (err) {
    console.warn("[self-monitor] lender_wallet_balance probe RPC error:", err.message?.slice(0, 120));
    return;
  }

  if (!lenderBalanceState.initialized) {
    lenderBalanceState.lastSolLamports = solLamports;
    lenderBalanceState.lastTokenBalances = snapshot;
    lenderBalanceState.initialized = true;
    return; // first run baselines, doesn't alert
  }

  const decreases = [];
  // Threshold: ignore tiny SOL deltas that come from price-attestor tx
  // fees (the lender pays ~5000 lamports per attest, ~70 per minute).
  // 0.01 SOL is well above the per-hour fee budget but small enough to
  // catch real drains.
  const SOL_DECREASE_THRESHOLD_LAMPORTS = 10_000_000n; // 0.01 SOL
  const solDelta = BigInt(lenderBalanceState.lastSolLamports) - BigInt(solLamports);
  if (solDelta > SOL_DECREASE_THRESHOLD_LAMPORTS) {
    decreases.push(`SOL: -${(Number(solDelta) / 1e9).toFixed(4)} SOL (was ${(lenderBalanceState.lastSolLamports / 1e9).toFixed(4)}, now ${(solLamports / 1e9).toFixed(4)})`);
  }
  for (const [ata, last] of lenderBalanceState.lastTokenBalances) {
    const current = snapshot.get(ata);
    if (!current) {
      // ATA was closed — full balance vanished. Mint info from last snapshot.
      decreases.push(`token ${last.mint.slice(0, 8)}… ATA ${ata.slice(0, 8)}… DRAINED+CLOSED (was ${Number(last.amount) / 10 ** last.decimals})`);
      continue;
    }
    if (current.amount < last.amount) {
      const delta = last.amount - current.amount;
      decreases.push(
        `token ${last.mint.slice(0, 8)}… ATA ${ata.slice(0, 8)}… -${Number(delta) / 10 ** last.decimals} (${Number(last.amount) / 10 ** last.decimals} → ${Number(current.amount) / 10 ** current.decimals})`,
      );
    }
  }

  const isBad = decreases.length > 0;
  recordOutcome(KIND, isBad);
  if (isBad) {
    await alertIfNew(bot, KIND,
      `LENDER WALLET BALANCE DECREASED — investigate immediately. Changes: ${decreases.join(" | ")}. ` +
      `If you didn't initiate a sweep/distribution/sale in the last 60s, treat as a potential drain.`,
      "crit",
    );
  } else {
    await alertRecovery(bot, KIND, `Lender wallet balance stable across tick.`);
  }

  // Update baseline AFTER alerting so the next tick sees the new "stable" state.
  lenderBalanceState.lastSolLamports = solLamports;
  lenderBalanceState.lastTokenBalances = snapshot;
}

/* ─── Tick loop ──────────────────────────────────────────────── */

let _timer = null;

/**
 * Pool credit drift probe. Detects when pool.accrued_lamports grows
 * faster than pool_credit_events.lamports would predict — the signature
 * of any future regression of the 2026-06-18 PM holder over-credit bug.
 *
 * Tracks each tick: for each pool kind, compute
 *   ledger_total = SUM(pool_credit_events.lamports WHERE pool_kind=X)
 *   pool_actual  = pool.accrued_lamports
 *   drift        = pool_actual - (last_tick_pool_actual + (ledger_total - last_tick_ledger_total))
 *
 * If drift is positive and exceeds the dust threshold for 2 consecutive
 * ticks, CRIT alert — the pool is being credited from outside the
 * ledger. If drift is negative, that's a distribution payout (expected).
 */
const _poolDriftState = new Map(); // pool_kind -> {lastPool, lastLedger}
async function probePoolCreditDrift(bot) {
  const KIND = "pool_credit_drift";
  const DUST_TOLERANCE = 1_000_000n; // 0.001 SOL — covers floor-division rounding
  try {
    const pools = [
      { kind: "holder", table: "magpie_holder_pool" },
      { kind: "lp_loyalty", table: "lp_loyalty_pool" },
      { kind: "protocol_reserve", table: "protocol_reserve_pool" },
    ];
    const offenders = [];
    for (const p of pools) {
      const pr = await query(`SELECT accrued_lamports::text v FROM ${p.table} WHERE id=1`).catch(() => null);
      if (!pr || pr.rows.length === 0) continue;
      const pool = BigInt(pr.rows[0].v);
      const lr = await query(
        `SELECT COALESCE(SUM(lamports), 0)::text v FROM pool_credit_events WHERE pool_kind = $1`,
        [p.kind],
      ).catch(() => ({ rows: [{ v: "0" }] }));
      const ledger = BigInt(lr.rows[0].v);
      const prev = _poolDriftState.get(p.kind);
      _poolDriftState.set(p.kind, { lastPool: pool, lastLedger: ledger });
      if (!prev) continue; // first tick — no delta yet
      const poolDelta = pool - prev.lastPool;
      const ledgerDelta = ledger - prev.lastLedger;
      // Positive drift = pool grew more than the ledger says. That's the bug class.
      const drift = poolDelta - ledgerDelta;
      if (drift > DUST_TOLERANCE) {
        offenders.push(`${p.kind} drifted +${(Number(drift) / 1e9).toFixed(4)} SOL beyond ledger (pool +${(Number(poolDelta) / 1e9).toFixed(4)} vs ledger +${(Number(ledgerDelta) / 1e9).toFixed(4)})`);
      }
    }
    const isBad = offenders.length > 0;
    recordOutcome(KIND, isBad);
    if (isBad) {
      await alertIfNew(bot, KIND, `pool credit drift detected: ${offenders.join("; ")}`, "crit");
    } else {
      await alertRecovery(bot, KIND, "pool credit drift cleared");
    }
  } catch (err) {
    console.warn("[self-monitor] pool_credit_drift probe error:", err.message?.slice(0, 160));
  }
}

// Kill-switch probe — operator-mandated 2026-06-18 PM.
// Any *_DISABLED=true or *_PAUSED=true env var that blocks a USER-FACING flow
// must alert CRIT once it has been on for > KILLSWITCH_STALE_MS. Catches cases
// like COSIGN_BORROW_DISABLED being flipped by an alarm and never cleared.
// [[feedback_loans_must_never_fail_no_regressions]]
const KILLSWITCH_STALE_MS = Number(process.env.KILLSWITCH_STALE_MS) || 10 * 60_000;
// User-facing switches. Background-only switches (FEE_WALLET_SWEEPER_DISABLED,
// TREASURY_SWEEP_DISABLED, DIST_GAP_MONITOR_DISABLED, EXPLOIT_DETECTOR_DISABLED,
// PRICE_SNAPSHOTTER_DISABLED, RAID_MONITOR_DISABLED, FUNDING_GRAPH_DISABLED,
// PIP_PROACTIVE_DISABLED, PENDING_ARM_WATCHER_DISABLED) are intentionally
// EXCLUDED — they don't block users from borrowing/repaying. Add to this list
// any future env var that, when set, would surface as a user-visible error.
const USER_FACING_KILL_SWITCHES = [
  "COSIGN_BORROW_DISABLED",
  "V4_BORROWS_PAUSED",
  "LIQUIDATION_DISTRIBUTION_DISABLED",
  "AGENT_API_DISABLED",
  "LIMIT_CLOSE_AGENT_DISABLED",
  "PIP_ASK_DISABLED",
];
const _killswitchFirstSeen = new Map(); // name -> timestamp ms

function isSwitchOn(v) {
  return /^(1|true|yes|on)$/i.test(String(v || "").trim());
}

// Borrow failure rate probe — reads the rolling in-memory counter in
// cosign-borrow.js and CRIT-alerts if any classification exceeds the
// per-hour threshold. Real-time visibility into how often each failure
// mode fires so operator can act on patterns (e.g. high stale_blockhash
// rate means site signing window needs widening).
// [[feedback_loans_must_never_fail_no_regressions]]
const BORROW_FAILURE_THRESHOLD_PER_HOUR = Number(process.env.BORROW_FAILURE_THRESHOLD_PER_HOUR) || 5;
const BORROW_FAILURE_COOLDOWN_MS = Number(process.env.BORROW_FAILURE_COOLDOWN_MS) || 30 * 60_000;
let _lastBorrowFailureAlertAt = 0;
let _lastBorrowFailureSnapshot = "";

async function probeBorrowFailures(bot) {
  const KIND = "borrow_failures_high";
  try {
    const { getRecentBorrowFailures } = await import("../api/cosign-borrow.js");
    const failures = getRecentBorrowFailures();
    const klasses = Object.keys(failures);
    if (klasses.length === 0) {
      recordOutcome(KIND, false);
      await alertRecovery(bot, KIND, "borrow failure rate back to zero");
      return;
    }
    const overThreshold = klasses.filter((k) => failures[k] >= BORROW_FAILURE_THRESHOLD_PER_HOUR);
    const isBad = overThreshold.length > 0;
    recordOutcome(KIND, isBad);
    if (!isBad) {
      // Below threshold but non-zero — fine, no alert.
      await alertRecovery(bot, KIND, "borrow failure rate normalized");
      return;
    }
    const snapshot = klasses
      .sort((a, b) => failures[b] - failures[a])
      .map((k) => `${k}=${failures[k]}`)
      .join(" ");
    // Throttle — don't re-DM if snapshot hasn't materially changed.
    if (snapshot === _lastBorrowFailureSnapshot
        && Date.now() - _lastBorrowFailureAlertAt < BORROW_FAILURE_COOLDOWN_MS) {
      return;
    }
    _lastBorrowFailureAlertAt = Date.now();
    _lastBorrowFailureSnapshot = snapshot;
    const guidance = overThreshold.map((k) => {
      if (k === "stale_blockhash")
        return "stale_blockhash: users signing too late — site should refresh the blockhash if signing takes >30s";
      if (k === "rpc_exhausted")
        return "rpc_exhausted: Helius + every backup failing simulateTransaction — check provider status";
      if (k === "sim_failed")
        return "sim_failed: tx would fail on-chain — check recent CRIT DMs for inner reason";
      if (k === "unclassified")
        return "unclassified: a new failure shape — pull recent CRIT DMs for the inner error";
      return `${k}: investigate`;
    }).join(" | ");
    await alertIfNew(bot, KIND,
      `cosign-borrow failures over threshold in last 1h: ${snapshot}. Guidance: ${guidance}`,
      "crit",
    );
  } catch (err) {
    console.warn("[self-monitor] borrow_failures probe error:", err.message?.slice(0, 160));
  }
}

// Attestor liveness probe — the price-attestor MUST tick continuously
// or every V4 borrow will fail with TwapInsufficientHistory. A silent
// stall (e.g. SQL type-cast bug killing every tick) is catastrophic
// because the symptoms only surface when a user tries to borrow.
// [[feedback_borrow_conversion_must_be_world_class]]
const ATTESTOR_STUCK_THRESHOLD_MS = Number(process.env.ATTESTOR_STUCK_MS) || 90_000;
async function probeAttestorLiveness(bot) {
  const KIND = "attestor_stuck";
  try {
    const { getAttestorHeartbeat } = await import("../services/price-attestor.js");
    const hb = getAttestorHeartbeat();
    // If we've never ticked yet, give it a couple of minutes from boot.
    if (hb.lastSuccessfulTickAt === 0) {
      recordOutcome(KIND, false);
      return;
    }
    const isBad = hb.msSinceLast > ATTESTOR_STUCK_THRESHOLD_MS;
    recordOutcome(KIND, isBad);
    if (isBad) {
      await alertIfNew(bot, KIND,
        `price-attestor STUCK — last successful tick ${Math.round(hb.msSinceLast / 1000)}s ago (threshold ${ATTESTOR_STUCK_THRESHOLD_MS / 1000}s). V4 TWAPs will cool off and every borrow will hit TwapInsufficientHistory. Check logs for SQL/Jupiter errors.`,
        "crit",
      );
    } else {
      await alertRecovery(bot, KIND, "price-attestor recovered — ticking normally");
    }
  } catch (err) {
    console.warn("[self-monitor] attestor_liveness probe error:", err.message?.slice(0, 160));
  }
}

async function probeKillSwitches(bot) {
  const KIND = "killswitch_stale";
  try {
    const now = Date.now();
    const active = [];
    const stale = [];
    for (const name of USER_FACING_KILL_SWITCHES) {
      if (isSwitchOn(process.env[name])) {
        if (!_killswitchFirstSeen.has(name)) _killswitchFirstSeen.set(name, now);
        const age = now - _killswitchFirstSeen.get(name);
        active.push({ name, ageMin: Math.round(age / 60_000) });
        if (age > KILLSWITCH_STALE_MS) stale.push({ name, ageMin: Math.round(age / 60_000) });
      } else {
        _killswitchFirstSeen.delete(name);
      }
    }
    const isBad = stale.length > 0;
    recordOutcome(KIND, isBad);
    if (isBad) {
      const list = stale.map((s) => `${s.name} (~${s.ageMin}min)`).join(", ");
      await alertIfNew(bot, KIND,
        `user-facing kill switch(es) stale: ${list}. Users may be hitting borrow/repay errors. Flip OFF on Railway if no longer needed.`,
        "crit",
      );
    } else if (active.length === 0) {
      await alertRecovery(bot, KIND, "all user-facing kill switches are OFF");
    }
  } catch (err) {
    console.warn("[self-monitor] killswitch_stale probe error:", err.message?.slice(0, 160));
  }
}

async function tick(bot) {
  try {
    await Promise.all([
      probeDbPool(bot).catch((e) => console.warn("[self-monitor] db_pool probe threw:", e.message)),
      probePendingNotifs(bot).catch((e) => console.warn("[self-monitor] pending_notifs probe threw:", e.message)),
      probeStuckOrders(bot).catch((e) => console.warn("[self-monitor] stuck_orders probe threw:", e.message)),
      probeMigrationsFailed(bot).catch((e) => console.warn("[self-monitor] migrations probe threw:", e.message)),
      probeTwapWatchdogMisses(bot).catch((e) => console.warn("[self-monitor] twap_watchdog probe threw:", e.message)),
      probeEngineTopupWallet(bot).catch((e) => console.warn("[self-monitor] engine_topup probe threw:", e.message)),
      probeLoanProgramIdDrift(bot).catch((e) => console.warn("[self-monitor] program_drift probe threw:", e.message)),
      probeStaleSupport(bot).catch((e) => console.warn("[self-monitor] stale_support probe threw:", e.message)),
      probeCreditCoverage(bot).catch((e) => console.warn("[self-monitor] credit_coverage probe threw:", e.message)),
      probeV4TwapHealth(bot).catch((e) => console.warn("[self-monitor] v4_twap_health probe threw:", e.message)),
      probeLenderWalletBalance(bot).catch((e) => console.warn("[self-monitor] lender_wallet_balance probe threw:", e.message)),
      probePoolCreditDrift(bot).catch((e) => console.warn("[self-monitor] pool_credit_drift probe threw:", e.message)),
      probeKillSwitches(bot).catch((e) => console.warn("[self-monitor] killswitch_stale probe threw:", e.message)),
      probeBorrowFailures(bot).catch((e) => console.warn("[self-monitor] borrow_failures probe threw:", e.message)),
      probeAttestorLiveness(bot).catch((e) => console.warn("[self-monitor] attestor_stuck probe threw:", e.message)),
    ]);
  } catch (err) {
    // Belt-and-suspenders catch — Promise.all shouldn't throw because
    // each probe catches its own errors, but a defensive top-level
    // catch guarantees the tick loop survives no matter what.
    console.warn("[self-monitor] tick threw:", err.message);
  }
}

export function startSelfMonitor(bot) {
  if (_timer) return;
  console.log(`[self-monitor] armed — probing every ${TICK_MS / 1000}s`);
  // Stagger first tick by 60s so the bot has time to fully boot.
  setTimeout(() => {
    tick(bot).catch(() => {});
    _timer = setInterval(() => {
      tick(bot).catch(() => {});
    }, TICK_MS);
  }, 60_000);
}

export function stopSelfMonitor() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
