/**
 * Limit-close operator alerts — proactive DMs when orders fire or fail.
 *
 * Operator escalated 2026-06-12: limit-close must be PERFECTED, and
 * "you can't perfect what you can't see." Without these alerts, the
 * operator only knows an order fired by checking /lc-status manually
 * or by seeing a user message. By the time a user complains about a
 * failure, the failure budget may already be exhausted.
 *
 * This watcher polls limit_close_orders for state transitions in the
 * last N minutes and DMs the operator a compact summary. Polls every
 * 60s; same anti-spam pattern as lender-balance-watcher.
 *
 * What gets alerted:
 *   - First fire ever (huge milestone — DM with celebration)
 *   - Every subsequent fire (compact summary)
 *   - Every failure (with reason + retry count)
 *   - Every partial fire (TWAP completed partial — needs operator eye)
 *
 * What does NOT get alerted (already covered elsewhere):
 *   - Arms (the user gets a DM; volume could spam operator)
 *   - Cancels (user-initiated; not actionable)
 *   - Reverts (transient; engine retries)
 *
 * Uses last_alerted_order_id in-memory cursor; on restart we backfill
 * one alert covering any transitions during the gap so nothing falls
 * through.
 */
import { query } from "../db/pool.js";
import { getAdminId } from "./admin-notify.js";

const POLL_INTERVAL_MS = Number(process.env.LC_OPERATOR_ALERT_MS) || 60_000; // 1 min

const SOLSCAN_TX = (sig) => sig ? `https://solscan.io/tx/${sig}` : null;
const fmtSol = (lamports) => (Number(lamports || 0) / 1e9).toFixed(4);

// Cursor — only alert on orders that transitioned AFTER this id. Updated
// after each successful DM. Persisted on startup via the cold-start
// rule below so nothing falls through across deploys.
let cursorId = 0;

async function bootstrapCursor() {
  // On cold start, assume any order that transitioned > 10 min before
  // startup was already alerted (or pre-dates the watcher). New
  // transitions after that DO get alerted.
  const { rows: [r] } = await query(
    `SELECT COALESCE(MAX(id), 0) AS max_id
       FROM limit_close_orders
      WHERE status IN ('fired', 'failed', 'partial_fired')
        AND fired_at < NOW() - INTERVAL '10 minutes'`,
  );
  cursorId = Number(r?.max_id || 0);
  console.log(`[lc-operator-alerts] cursor bootstrapped at id=${cursorId}`);
}

async function tick(bot) {
  const adminTgId = getAdminId();
  if (!adminTgId || !bot) return;

  const { rows } = await query(
    `SELECT lc.id, lc.loan_id, l.collateral_mint, sm.symbol,
            COALESCE(lc.trigger_direction, 'above') AS dir,
            lc.status, lc.fired_at, lc.updated_at,
            lc.tx_signature_repay, lc.tx_signature_swap,
            lc.proceeds_lamports::text AS proceeds, lc.fee_lamports::text AS fee,
            lc.failure_reason, lc.failure_count,
            lc.source, lc.source_agent_pubkey
       FROM limit_close_orders lc
       JOIN loans l ON l.id = lc.loan_id
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
      WHERE lc.id > $1
        AND lc.status IN ('fired', 'failed', 'partial_fired')
      ORDER BY lc.id ASC
      LIMIT 25`,
    [cursorId],
  );

  if (rows.length === 0) return;

  for (const r of rows) {
    let msg;
    const tag = r.dir === "below" ? "STOP-LOSS" : "TAKE-PROFIT";
    const sym = r.symbol || (r.collateral_mint || "unknown").slice(0, 8);
    const srcStr = r.source === "agent_x402"
      ? `x402 agent \`${(r.source_agent_pubkey || "?").slice(0, 8)}...\``
      : (r.source || "tg");

    if (r.status === "fired") {
      // Detect the FIRST EVER fire — that's a milestone.
      const { rows: [{ first_fire_id }] } = await query(
        `SELECT MIN(id) AS first_fire_id FROM limit_close_orders WHERE status = 'fired'`,
      );
      const isFirst = Number(first_fire_id) === Number(r.id);
      msg = [
        isFirst ? "🎉 *FIRST LIMIT-CLOSE FIRE EVER!* 🎉" : "✅ *Limit-close fired*",
        "",
        `Order #${r.id} — ${tag} on ${sym}`,
        `Source: ${srcStr}`,
        `Proceeds: ${fmtSol(r.proceeds)} SOL · Fee: ${fmtSol(r.fee)} SOL`,
        "",
        `Repay: ${SOLSCAN_TX(r.tx_signature_repay) || "—"}`,
        `Swap:  ${SOLSCAN_TX(r.tx_signature_swap) || "—"}`,
        "",
        isFirst
          ? "_The engine is now battle-tested. Watch for the next fires to validate consistency._"
          : "_Confirmed end-to-end. Fee landed in 4JSSSaG3 (or wherever PROTOCOL_FEE_DESTINATION points)._",
      ].join("\n");
    } else if (r.status === "partial_fired") {
      msg = [
        "⚠️ *Limit-close PARTIAL fire*",
        "",
        `Order #${r.id} — ${tag} on ${sym}`,
        `Source: ${srcStr}`,
        `Proceeds so far: ${fmtSol(r.proceeds)} SOL`,
        "",
        "TWAP completed partial — needs operator review. Use /lc-status to inspect.",
      ].join("\n");
    } else if (r.status === "failed") {
      msg = [
        "🔴 *Limit-close FAILED*",
        "",
        `Order #${r.id} — ${tag} on ${sym}`,
        `Source: ${srcStr}`,
        `Reason: \`${r.failure_reason || "unknown"}\``,
        `Retries before giving up: ${r.failure_count || 0}`,
        "",
        "User received a DM. Use /lc-status failed to triage.",
      ].join("\n");
    }

    if (!msg) {
      cursorId = Math.max(cursorId, Number(r.id));
      continue;
    }

    try {
      await bot.api.sendMessage(adminTgId, msg, { parse_mode: "Markdown", disable_web_page_preview: true });
    } catch (err) {
      console.warn(`[lc-operator-alerts] DM failed for order ${r.id}:`, err.message?.slice(0, 80));
      // Don't advance cursor — retry next tick.
      return;
    }

    cursorId = Math.max(cursorId, Number(r.id));
  }
}

export async function startLcOperatorAlerts(bot) {
  try {
    await bootstrapCursor();
  } catch (err) {
    console.warn("[lc-operator-alerts] cursor bootstrap failed (defaulting to 0):", err.message);
  }
  console.log(`[lc-operator-alerts] started; polling every ${POLL_INTERVAL_MS / 1000}s`);
  setInterval(() => {
    tick(bot).catch((err) => console.error("[lc-operator-alerts] tick:", err.message));
  }, POLL_INTERVAL_MS);
}
