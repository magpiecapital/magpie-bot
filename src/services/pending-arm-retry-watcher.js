/**
 * Pending-arm retry watcher.
 *
 * Tier-2 architectural defense (defense B in
 * [[feedback_loan_830_full_postmortem_and_defenses]]). Operator-mandated
 * 2026-06-17 PM after the same arm-race class hit operator 3 times in
 * one day (loans 820, 826, 830).
 *
 * WHAT IT SOLVES
 * ──────────────
 * When the site beacons signed arm-batch requests immediately after a
 * V4 borrow co-signs, sometimes the cosign-borrow DB write hasn't
 * landed yet. arm-core's phase 1 polling (30s) is usually enough — but
 * Solana congestion can push DB-write latency past that window.
 *
 * Before this watcher: race timeout → return error → site flips intents
 * to failed → recovery banner appears.
 *
 * After this watcher: race timeout → arm-core writes a pending_arm row
 * with the parsed legs + envelope freshness anchor. Site receives a
 * 202 + pending_arm_id. The watcher polls every 10s; the moment the
 * loan row appears in DB it re-calls armOrderBatch with skipPendingQueue
 * so a second race can't re-queue. Orders land, dashboard catches up
 * on its next poll, intents auto-reconcile to 'armed' through the
 * normal arm-core path. User never has to re-sign.
 *
 * SAFETY
 * ──────
 *  - 5-min envelope-freshness ceiling. After that the row is expired
 *    and admin DM'd; user has to manually retry from banner.
 *  - skipPendingQueue=true on replay so a single arm can never queue
 *    itself twice from the same watcher tick.
 *  - SELECT-FOR-UPDATE-SKIP-LOCKED + per-row UPDATE-to-'processing'
 *    sentinel so multiple bot replicas (if Railway scales) can't
 *    double-arm the same pending row.
 *  - retry_count cap of 30 (~5 min at 10s cadence) — defense-in-depth
 *    against a stuck row that keeps returning pending=true somehow.
 *  - DISABLED via PENDING_ARM_WATCHER_DISABLED env for emergency stop.
 *
 * Best-effort logging + admin DM on every armed/expired/failed
 * transition so the operator has a live signal on watcher behavior.
 */
import { query } from "../db/pool.js";
import { notifyAdmin } from "./admin-notify.js";
import { markCycle } from "../lib/heartbeat.js";

const INTERVAL_MS = Number(
  process.env.PENDING_ARM_WATCHER_INTERVAL_MS || 10_000,
);
const ENVELOPE_FRESH_MS = 5 * 60 * 1000;
const MAX_RETRY_COUNT = 30;
const BATCH_LIMIT = 25;

let _timer = null;
let _running = false;

export function startPendingArmRetryWatcher(bot) {
  if (_timer) return;
  if (/^(1|true|yes|on)$/i.test(process.env.PENDING_ARM_WATCHER_DISABLED || "")) {
    console.log("[pending-arm] DISABLED via PENDING_ARM_WATCHER_DISABLED env");
    return;
  }
  // First tick after 30s so the boot storm settles. markCycle on each
  // successful run → provable on /health heartbeats (audit 2026-06-28 P2).
  setTimeout(() => {
    runOnce(bot)
      .then(() => markCycle("pending-arm-watcher"))
      .catch((e) => console.warn(`[pending-arm] first tick failed: ${e.message?.slice(0, 160)}`));
    _timer = setInterval(() => {
      if (_running) {
        // Previous tick still in flight — skip this one so we don't
        // pile up overlapping iterations during slow DB queries.
        return;
      }
      runOnce(bot)
        .then(() => markCycle("pending-arm-watcher"))
        .catch((e) => console.warn(`[pending-arm] tick failed: ${e.message?.slice(0, 160)}`));
    }, INTERVAL_MS);
  }, 30_000);
  console.log(
    `[pending-arm] armed — first tick in 30s, then every ${INTERVAL_MS / 1000}s`,
  );
}

export function stopPendingArmRetryWatcher() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

async function runOnce(bot) {
  _running = true;
  try {
    await expireStaleRows(bot);
    await retryFreshRows(bot);
  } finally {
    _running = false;
  }
}

/* ─────────────────────────────────────────────────────────────────
 * Expire any rows whose envelope freshness window has elapsed.
 * Admin DMs the operator with full context — these are exceptions
 * worth investigating per
 * [[feedback_loan_830_full_postmortem_and_defenses]].
 * ───────────────────────────────────────────────────────────────── */
async function expireStaleRows(bot) {
  const { rows: expired } = await query(
    `UPDATE pending_arms
        SET status = 'expired',
            updated_at = NOW()
      WHERE status = 'pending'
        AND envelope_issued_at < NOW() - INTERVAL '5 minutes'
      RETURNING id, user_id, signer_pubkey, wallet, loan_id_chain,
                legs, intent_ids, retry_count, last_retry_error, envelope_issued_at`,
  );
  for (const row of expired) {
    const dmText =
      `pending-arm EXPIRED — envelope freshness elapsed\n` +
      `\n` +
      `pending_arm_id: ${row.id}\n` +
      `loan_id_chain: ${row.loan_id_chain}\n` +
      `user_id: ${row.user_id}\n` +
      `wallet: ${row.wallet?.slice(0, 12) || "?"}…\n` +
      `signed_at: ${new Date(row.envelope_issued_at).toISOString()}\n` +
      `retries: ${row.retry_count}\n` +
      `last_error: ${(row.last_retry_error || "n/a").slice(0, 200)}\n` +
      `n_legs: ${Array.isArray(row.legs) ? row.legs.length : "?"}\n` +
      `\n` +
      `Loan row never appeared within the 5-min envelope window. ` +
      `Recovery banner will surface intents for user to retry manually.`;
    try {
      await notifyAdmin(dmText);
    } catch (e) {
      console.warn(`[pending-arm] expire DM failed: ${e.message?.slice(0, 120)}`);
    }
    console.warn(
      `[pending-arm] EXPIRED pending_arm_id=${row.id} loan_id_chain=${row.loan_id_chain} retries=${row.retry_count}`,
    );

    // Reconcile intents to 'failed' so the recovery banner can pick
    // them up. Without this, intents sit at 'pending' forever and the
    // banner never surfaces.
    if (Array.isArray(row.intent_ids) && row.intent_ids.length > 0) {
      try {
        await query(
          `UPDATE arm_intents
              SET status = 'failed',
                  error_code = 'pending_arm_envelope_expired',
                  error_detail = 'Cosign-borrow DB-write never landed inside 5-min signature freshness window',
                  updated_at = NOW()
            WHERE id = ANY($1::bigint[]) AND status = 'pending'`,
          [row.intent_ids],
        );
      } catch (e) {
        console.warn(`[pending-arm] expire intent reconcile failed: ${e.message?.slice(0, 120)}`);
      }
    }

    // Sprint Item 5 (V4 hardening 2026-06-17) — surface the expiry to
    // the BORROWER via TG, with a one-tap retry. Operator-mandated:
    // the recovery banner is a safety net, not a workflow — the user
    // should be PROACTIVELY nudged that their auto-sell setup needs a
    // quick re-sign. Without this DM, the user only finds out when
    // they happen to check the dashboard.
    //
    // Best-effort: missing TG link, missing bot handle, or any send
    // failure logs + continues. We do NOT block any other watcher
    // behavior on the DM landing.
    try {
      await sendBorrowerExpiryDm(bot, row);
    } catch (e) {
      console.warn(`[pending-arm] borrower DM failed for pending_arm_id=${row.id}: ${e.message?.slice(0, 120)}`);
    }
  }
}

/* ─────────────────────────────────────────────────────────────────
 * Borrower-facing expiry DM with a one-tap retry CTA.
 *
 * Sprint Item 5 (feedback_v4_hardening_sprint_2026_06_17.md).
 * ───────────────────────────────────────────────────────────────── */
async function sendBorrowerExpiryDm(bot, row) {
  if (!bot) return;

  // Resolve telegram_id from the borrower's user_id. wallet/user_id are
  // populated when the original /arm-batch came in; if the user has
  // never linked TG, telegram_id is NULL and we silently skip.
  const { rows: [userRow] } = await query(
    `SELECT telegram_id FROM users WHERE id = $1`,
    [row.user_id],
  );
  if (!userRow?.telegram_id) {
    console.log(`[pending-arm] no TG link for user_id=${row.user_id} — skipping borrower expiry DM`);
    return;
  }

  // Resolve the symbol for friendlier copy. Falls back gracefully if
  // the loan never landed AND no supported_mints lookup is possible.
  let symbol = "your loan";
  try {
    const { rows: [m] } = await query(
      `SELECT sm.symbol
         FROM supported_mints sm
        WHERE sm.mint = (
          SELECT collateral_mint FROM loans WHERE loan_id::text = $1 LIMIT 1
        )`,
      [String(row.loan_id_chain)],
    );
    if (m?.symbol) symbol = m.symbol;
  } catch {}

  const nLegs = Array.isArray(row.legs) ? row.legs.length : 0;
  const lines = [
    `Quick heads-up — your auto-sell setup on ${symbol} loan #${row.loan_id_chain} ` +
      `needs a re-sign.`,
    ``,
    `We tried for 5 minutes to land the ${nLegs} ${nLegs === 1 ? "leg" : "legs"} you signed, ` +
      `but the borrow itself didn't confirm in that window. Your signature has expired ` +
      `for security reasons.`,
    ``,
    `Open your dashboard to retry — your strikes are still saved.`,
  ];

  try {
    await bot.telegram.sendMessage(
      Number(userRow.telegram_id),
      lines.join("\n"),
      {
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Open dashboard to retry",
                url: process.env.SITE_DASHBOARD_URL || "https://magpie.capital/dashboard",
              },
            ],
          ],
        },
      },
    );
    console.log(
      `[pending-arm] borrower DM sent — pending_arm_id=${row.id} user_id=${row.user_id} tg=${userRow.telegram_id}`,
    );
  } catch (sendErr) {
    // Most common: user blocked the bot. Log + drop.
    console.warn(
      `[pending-arm] borrower DM send failed for pending_arm_id=${row.id}: ${sendErr.message?.slice(0, 120)}`,
    );
  }
}

/* ─────────────────────────────────────────────────────────────────
 * Replay pending rows whose envelopes are still fresh.
 * ───────────────────────────────────────────────────────────────── */
async function retryFreshRows(bot) {
  const { rows: candidates } = await query(
    `SELECT id, user_id, signer_pubkey, wallet, loan_id_chain,
            legs, intent_ids, source, arm_note_prefix,
            envelope_issued_at, retry_count
       FROM pending_arms
      WHERE status = 'pending'
        AND envelope_issued_at >= NOW() - INTERVAL '5 minutes'
        AND retry_count < $1
      ORDER BY id ASC
      LIMIT $2`,
    [MAX_RETRY_COUNT, BATCH_LIMIT],
  );

  if (candidates.length === 0) return;

  const { armOrderBatch } = await import("./limit-close-arm-core.js");

  for (const row of candidates) {
    // Bump retry_count immediately so a hung replay doesn't starve
    // the watcher loop and so concurrent ticks (if multiple replicas)
    // see a moving counter.
    const claim = await query(
      `UPDATE pending_arms
          SET retry_count = retry_count + 1,
              last_retry_at = NOW(),
              updated_at = NOW()
        WHERE id = $1 AND status = 'pending'
        RETURNING id`,
      [row.id],
    );
    if (claim.rowCount === 0) continue; // another replica grabbed it

    let result;
    try {
      result = await armOrderBatch({
        userId: row.user_id,
        source: row.source || "site",
        loanIdChain: String(row.loan_id_chain),
        legs: row.legs,
        intentIds: Array.isArray(row.intent_ids) ? row.intent_ids : null,
        armNotePrefix: row.arm_note_prefix || null,
        // Critical: skipPendingQueue=true so a second race in this
        // replay doesn't re-queue this same arm and create an
        // infinite-replay cycle.
        skipPendingQueue: true,
      });
    } catch (err) {
      result = {
        ok: false,
        error: "watcher_exception",
        detail: (err?.message || String(err)).slice(0, 200),
      };
    }

    if (result.ok && result.pending !== true) {
      // SUCCESS — arms landed. Mark armed and DM operator.
      const orderIds = Array.isArray(result.orderIds) ? result.orderIds : [];
      try {
        await query(
          `UPDATE pending_arms
              SET status = 'armed',
                  order_ids = $2,
                  last_retry_error = NULL,
                  updated_at = NOW()
            WHERE id = $1`,
          [row.id, orderIds.length > 0 ? orderIds : null],
        );
      } catch (e) {
        console.warn(`[pending-arm] success update failed: ${e.message?.slice(0, 120)}`);
      }
      console.log(
        `[pending-arm] ARMED pending_arm_id=${row.id} loan_id_chain=${row.loan_id_chain} retry=${row.retry_count + 1} order_ids=${orderIds.join(",")}`,
      );
      try {
        await notifyAdmin(
          `pending-arm REPLAY OK — race healed by background watcher\n` +
          `pending_arm_id: ${row.id}\n` +
          `loan_id_chain: ${row.loan_id_chain}\n` +
          `retries to succeed: ${row.retry_count + 1}\n` +
          `order_ids: ${orderIds.join(", ") || "(none)"}\n` +
          `User never had to re-sign — Tier-2 defense working as designed.`,
        );
      } catch {}
      continue;
    }

    if (result.ok && result.pending === true) {
      // Defense-in-depth: shouldn't happen since we passed
      // skipPendingQueue=true. If it does, log and keep retrying.
      console.warn(
        `[pending-arm] watcher got pending=true despite skipPendingQueue — pending_arm_id=${row.id}`,
      );
      continue;
    }

    // Non-race failure — record and keep retrying until retry_count
    // cap or envelope expiry. We don't mark 'failed' here because the
    // next tick might succeed (e.g. loan_not_found_for_user where the
    // loan finally lands).
    const errStr = `${result.error || "unknown"}${result.detail ? `: ${typeof result.detail === "string" ? result.detail.slice(0, 160) : "[object]"}` : ""}`;
    try {
      await query(
        `UPDATE pending_arms
            SET last_retry_error = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [row.id, errStr.slice(0, 400)],
      );
    } catch {}

    // If the error is anything OTHER than the race itself, it's not
    // going to fix itself — mark failed and DM. Examples:
    // collateral_not_enabled, exits_require_v4_loan.
    const TRANSIENT_ERRORS = new Set([
      "loan_not_found_for_user",
      "watcher_exception",
    ]);
    // loan_not_active is transient ONLY while the loan is still FINALIZING
    // (borrow committed the row but hasn't flipped to 'active' yet). Once it's
    // active a replay succeeds; a TERMINAL status (repaid/liquidated/…) never
    // will → hard-fail. result.detail carries the loan status string.
    const TERMINAL_LOAN_STATUSES = new Set(["repaid", "liquidated", "cancelled", "closed", "defaulted", "refunded"]);
    const isFinalizingRace =
      result.error === "loan_not_active" &&
      typeof result.detail === "string" &&
      !TERMINAL_LOAN_STATUSES.has(result.detail.trim().toLowerCase());
    if (!TRANSIENT_ERRORS.has(result.error) && !isFinalizingRace) {
      try {
        await query(
          `UPDATE pending_arms
              SET status = 'failed',
                  last_retry_error = $2,
                  updated_at = NOW()
            WHERE id = $1`,
          [row.id, errStr.slice(0, 400)],
        );
      } catch {}
      console.warn(
        `[pending-arm] FAILED pending_arm_id=${row.id} loan_id_chain=${row.loan_id_chain} error=${result.error}`,
      );
      try {
        await notifyAdmin(
          `pending-arm REPLAY FAILED — non-transient error\n` +
          `pending_arm_id: ${row.id}\n` +
          `loan_id_chain: ${row.loan_id_chain}\n` +
          `user_id: ${row.user_id}\n` +
          `error: ${result.error}\n` +
          `detail: ${(typeof result.detail === "string" ? result.detail : "").slice(0, 200)}\n` +
          `Watcher stopped retrying. Recovery banner will surface for user.`,
        );
      } catch {}

      // Reconcile intents to failed so banner can surface them.
      if (Array.isArray(row.intent_ids) && row.intent_ids.length > 0) {
        try {
          await query(
            `UPDATE arm_intents
                SET status = 'failed',
                    error_code = $2,
                    error_detail = $3,
                    updated_at = NOW()
              WHERE id = ANY($1::bigint[]) AND status = 'pending'`,
            [
              row.intent_ids,
              String(result.error).slice(0, 64),
              errStr.slice(0, 400),
            ],
          );
        } catch {}
      }
      continue;
    }

    // Transient — keep going. Throttle the log so we don't spam.
    if ((row.retry_count + 1) % 5 === 0) {
      console.log(
        `[pending-arm] still_pending pending_arm_id=${row.id} loan_id_chain=${row.loan_id_chain} retry=${row.retry_count + 1}/${MAX_RETRY_COUNT}`,
      );
    }
  }
}
