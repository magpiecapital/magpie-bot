/**
 * Stale arm-intent DM watcher — proactive recovery for silent arm
 * drops on V4 loans.
 *
 * Mandated by [[feedback_tg_v4_must_match_site_quality]] +
 * [[feedback_arms_must_execute_without_babysitting]]. The site
 * recovery banner + /fixarm command are REACTIVE: they only help if
 * the user happens to look. This watcher is PROACTIVE: every minute
 * it scans for arm_intents that have been pending > 90s with no
 * matching armed/firing order, and DMs the user a one-tap-retry
 * recovery prompt before they have to notice the problem themselves.
 *
 * Operates on V4 loans only — V1/V2/V3 loans can't take new exits
 * (exits_require_v4_loan), so DM'ing the user would just confuse.
 *
 * Idempotency: when a DM is enqueued, the intent's updated_at is
 * stamped. Only intents where updated_at = created_at are eligible.
 * That makes the DM-once invariant robust across restarts without
 * needing a new column.
 */
import { query } from "../db/pool.js";

const TICK_INTERVAL_MS = Number(process.env.STALE_INTENT_TICK_MS || 60_000); // 60s
const MIN_AGE_SECONDS = Number(process.env.STALE_INTENT_MIN_AGE_S || 90); // 1.5 min before nudging
const MAX_AGE_HOURS = Number(process.env.STALE_INTENT_MAX_AGE_H || 24); // skip after 24h
const NUDGE_BATCH_LIMIT = 25; // soft cap per tick

let _timer = null;

export function startStaleArmIntentWatcher() {
  if (_timer) return;
  // First run after 90s so the boot reconciler can clear any pre-existing
  // stuck intents first.
  setTimeout(() => {
    runOnce().catch((e) =>
      console.warn(`[stale-arm-intent-watcher] first run failed: ${e.message?.slice(0, 160)}`),
    );
    _timer = setInterval(() => {
      runOnce().catch((e) =>
        console.warn(`[stale-arm-intent-watcher] tick failed: ${e.message?.slice(0, 160)}`),
      );
    }, TICK_INTERVAL_MS);
  }, 90_000);
  console.log(
    `[stale-arm-intent-watcher] armed — first run in 90s, then every ${Math.round(TICK_INTERVAL_MS / 1000)}s`,
  );
}

export function stopStaleArmIntentWatcher() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

async function runOnce() {
  const v4ProgramId = process.env.PROGRAM_ID_V4 || null;
  if (!v4ProgramId) {
    // Without V4 there are no exit-only loans to recover; bail.
    return;
  }

  // Expire any pending intent older than 1h that still has no matching
  // armed/firing order. Operator-mandated 2026-06-17 03:50 UTC
  // (feedback_no_duplicate_intents_in_recovery_banner_NEVER.md):
  // pending status must reflect reality. After 1h with no armed order,
  // the arm definitely didn't go through — mark the row as expired so
  // the recovery banner stops surfacing it forever. The user can always
  // re-arm; the new attempt creates a fresh intent (or dedupes back to
  // a still-valid pending one within the 5-min window).
  try {
    const { rowCount } = await query(
      `UPDATE arm_intents ai
          SET status = 'failed',
              error_code = 'expired_pending',
              error_detail = 'No matching armed/firing order materialized within 1h of the intent. Arm did not complete.',
              updated_at = NOW()
        WHERE ai.status = 'pending'
          AND ai.created_at < NOW() - INTERVAL '1 hour'
          AND NOT EXISTS (
            SELECT 1 FROM limit_close_orders o
             JOIN loans l ON l.id = o.loan_id
             WHERE l.loan_id::text = ai.loan_id_chain
               AND o.status IN ('armed','firing','twap_in_progress','awaiting_user','fired')
               AND o.trigger_direction = ai.direction
               AND o.trigger_value_micro = ai.target_value_micro
          )`,
    );
    if (rowCount > 0) {
      console.log(`[stale-arm-intent-watcher] expired ${rowCount} pending intent(s) > 1h old`);
    }
  } catch (e) {
    console.warn(`[stale-arm-intent-watcher] expire-old-pendings failed: ${e.message?.slice(0, 120)}`);
  }

  // Pull pending intents that:
  //   1) sit > MIN_AGE_SECONDS old
  //   2) are no older than MAX_AGE_HOURS (don't nudge ancient ones)
  //   3) have NEVER been nudged (updated_at = created_at — tolerance of 1s)
  //   4) sit on a V4 loan
  //   5) have no matching armed/firing order on the same loan+direction+strike
  const { rows: stale } = await query(
    `SELECT ai.id, ai.user_id, ai.wallet, ai.loan_id_chain,
            ai.direction, ai.target_kind,
            ai.target_value_micro::text AS target_value_micro,
            ai.slice_pct_bps,
            l.id AS loan_db_id,
            sm.symbol AS collateral_symbol
       FROM arm_intents ai
       JOIN loans l ON l.loan_id::text = ai.loan_id_chain
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
      WHERE ai.status = 'pending'
        AND l.program_id = $1
        AND l.status = 'active'
        AND ai.created_at < NOW() - make_interval(secs => $2)
        AND ai.created_at > NOW() - make_interval(hours => $3)
        AND ai.updated_at <= ai.created_at + INTERVAL '1 second'
        AND NOT EXISTS (
          SELECT 1 FROM limit_close_orders o
           WHERE o.loan_id = l.id
             AND o.status IN ('armed','firing','twap_in_progress','awaiting_user')
             AND o.trigger_direction = ai.direction
             AND o.trigger_value_micro = ai.target_value_micro
        )
      ORDER BY ai.created_at ASC
      LIMIT $4`,
    [v4ProgramId, MIN_AGE_SECONDS, MAX_AGE_HOURS, NUDGE_BATCH_LIMIT],
  );

  if (stale.length === 0) return;

  for (const row of stale) {
    // Skip if user_id missing (can't DM without it) — best-effort backfill.
    let userId = row.user_id;
    if (!userId) {
      try {
        const w = await query(
          `SELECT user_id FROM wallets WHERE public_key = $1 LIMIT 1`,
          [row.wallet],
        );
        if (w.rows[0]?.user_id) userId = w.rows[0].user_id;
      } catch {
        /* fall through */
      }
    }
    if (!userId) continue;

    const v = Number(row.target_value_micro) / 1e6;
    const sliceBps = row.slice_pct_bps ?? 10000;
    let label;
    if (row.target_kind === "multiplier") {
      label = `${v}x`;
      if (sliceBps < 10000) label += ` (${(sliceBps / 100).toFixed(0)}% slice)`;
    } else if (row.target_kind === "price_usd") {
      label = v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(8)}`;
    } else if (row.target_kind === "mc_usd") {
      label =
        v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B mc` : `$${(v / 1e6).toFixed(2)}M mc`;
    } else if (row.target_kind === "price_sol") {
      label = `${v.toFixed(6)} SOL`;
    } else {
      label = `${row.target_kind} ${v}`;
    }

    const sym = row.collateral_symbol || "your loan";
    const verb = row.direction === "above" ? "auto-sell" : "stop-loss";

    // Stamp updated_at FIRST so a duplicate tick on a slow run can't
    // re-enqueue the same DM. If the enqueue fails after, the intent
    // is still marked as nudged — that's the right tradeoff (no spam).
    try {
      await query(
        `UPDATE arm_intents SET updated_at = NOW() WHERE id = $1 AND updated_at <= created_at + INTERVAL '1 second'`,
        [row.id],
      );
    } catch (e) {
      console.warn(`[stale-arm-intent-watcher] mark-nudged failed for intent ${row.id}: ${e.message?.slice(0, 100)}`);
      continue;
    }

    const payload = {
      intent_id: row.id,
      loan_id_chain: row.loan_id_chain,
      collateral_symbol: row.collateral_symbol,
      target_kind: row.target_kind,
      target_value_micro: row.target_value_micro,
      slice_pct_bps: row.slice_pct_bps,
      direction: row.direction,
      strike_label: label,
      // Notification sender constructs the inline keyboard from these
      // fields; the recovery action routes through fixarm:intent:.. so
      // it lands on the same handler the dashboard banner uses.
      recovery_command: "/fixarm",
      recovery_callback: `fixarm:intent:${row.loan_id_chain}:${row.id}`,
      message_text:
        `Your ${verb} on ${sym} (loan #${row.loan_id_chain}) didn't finish arming — strike was *${label}*. ` +
        `Tap to retry now or use /fixarm.`,
    };

    try {
      await query(
        `INSERT INTO pending_notifications (user_id, channel, kind, payload, status)
           VALUES ($1, 'tg', 'arm_intent_stale', $2::jsonb, 'pending')`,
        [userId, JSON.stringify(payload)],
      );
    } catch (e) {
      console.warn(`[stale-arm-intent-watcher] DM enqueue failed for intent ${row.id}: ${e.message?.slice(0, 120)}`);
      // Roll back the updated_at bump so a future tick will re-try.
      try {
        await query(
          `UPDATE arm_intents SET updated_at = created_at WHERE id = $1`,
          [row.id],
        );
      } catch {
        /* swallow */
      }
    }
  }

  console.log(`[stale-arm-intent-watcher] nudged ${stale.length} stale intent(s)`);
}
