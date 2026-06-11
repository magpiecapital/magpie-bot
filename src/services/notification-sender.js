/**
 * Notification sender — consumes pending_notifications and sends TG DMs.
 *
 * Decouples the (private) limit-close engine from the (public) bot's TG
 * library: the engine writes notification rows, this worker dispatches
 * them. Same pattern can carry future cross-service events (alerts from
 * the price attestor, the shadow-pool watcher, etc.) without touching
 * those services.
 *
 * Concurrency safety:
 *   - Uses an atomic claim (`UPDATE WHERE status='pending' AND id IN (...)
 *     RETURNING`) so two bot instances running concurrently never deliver
 *     the same notification twice.
 *   - Failed sends increment attempt_count; rows with attempt_count >=
 *     MAX_ATTEMPTS are marked 'failed' and skipped.
 *
 * Templates live in this file. The engine emits structured payloads
 * (kind + JSONB); rendering happens here so the engine never imports
 * the TG library or its formatting rules.
 */
import { query } from "../db/pool.js";

const POLL_INTERVAL_MS = 5_000;
const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 5;

/* ─── Rendering ─────────────────────────────────────────────────── */

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

function fmtMcUsd(micros) {
  const usd = Number(micros) / 1e6;
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(2)}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(2)}M`;
  return `$${usd.toFixed(2)}`;
}

function renderLimitCloseArmed(p) {
  return [
    `*Limit-close armed* — order #${p.order_id}`,
    ``,
    `Loan: #${p.loan_id_chain}`,
    `Trigger: ${p.trigger_label}`,
    `Slippage: ${(p.slippage_bps / 100).toFixed(2)}%`,
    `Destination: ${p.sell_destination.toUpperCase()}`,
    ``,
    `I'll repay and sell automatically when the trigger fires.`,
  ].join("\n");
}

function renderLimitCloseFired(p) {
  return [
    `*Limit-close FIRED* — order #${p.order_id}`,
    ``,
    `Trigger: ${p.trigger_label} ✓`,
    `Repaid: ${fmtSol(p.loan_owed_lamports)} SOL · [tx](https://solscan.io/tx/${p.tx_repay})`,
    `Sold: ${p.collateral_sold_human} ${p.collateral_symbol} → ${fmtSol(p.proceeds_lamports)} ${p.dest.toUpperCase()} · [tx](https://solscan.io/tx/${p.tx_swap})`,
    `Fee: ${fmtSol(p.fee_lamports)} ${p.dest.toUpperCase()} (1%)`,
    ``,
    `Net to your wallet: *${fmtSol(p.net_to_user_lamports)} ${p.dest.toUpperCase()}*`,
  ].join("\n");
}

function renderLimitCloseFailed(p) {
  return [
    `*Limit-close FAILED* — order #${p.order_id}`,
    ``,
    `Reason: ${p.reason}`,
    p.detail ? `Detail: ${p.detail}` : null,
    ``,
    `Your loan is *unchanged*. Set a new order with /limitclose or close manually with /repay.`,
  ].filter(Boolean).join("\n");
}

function renderLimitCloseCancelled(p) {
  return [
    `*Limit-close cancelled* — order #${p.order_id}`,
    ``,
    `Reason: ${p.reason}`,
  ].join("\n");
}

const RENDERERS = {
  limit_close_armed:     renderLimitCloseArmed,
  limit_close_fired:     renderLimitCloseFired,
  limit_close_failed:    renderLimitCloseFailed,
  limit_close_cancelled: renderLimitCloseCancelled,
};

function renderPayload(kind, payload) {
  const fn = RENDERERS[kind];
  if (!fn) return null;
  try {
    return fn(payload);
  } catch (err) {
    console.error(`[notification-sender] render failed for kind=${kind}:`, err.message);
    return null;
  }
}

/* ─── Worker loop ───────────────────────────────────────────────── */

let _timer = null;

async function tick(bot) {
  // Atomic claim — flip a batch from 'pending' to 'sending' and read their
  // contents in one round trip. Other bot instances racing the same claim
  // get a disjoint slice.
  const claim = await query(
    `WITH next AS (
       SELECT id FROM pending_notifications
        WHERE status = 'pending' AND attempt_count < $2
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE pending_notifications SET status = 'sending', attempt_count = attempt_count + 1
      WHERE id IN (SELECT id FROM next)
      RETURNING id, user_id, channel, kind, payload, attempt_count`,
    [BATCH_SIZE, MAX_ATTEMPTS],
  );
  if (claim.rows.length === 0) return;

  for (const row of claim.rows) {
    let success = false;
    let lastError = null;
    try {
      if (row.channel !== "tg") {
        // Future channels — for v1 we only handle tg.
        lastError = `unsupported_channel: ${row.channel}`;
      } else {
        const text = renderPayload(row.kind, row.payload);
        if (!text) {
          lastError = `unknown_kind: ${row.kind}`;
        } else {
          // Look up the user's telegram_id from the users table.
          const { rows: [u] } = await query(
            `SELECT telegram_id FROM users WHERE id = $1`,
            [row.user_id],
          );
          if (!u?.telegram_id) {
            lastError = `user_has_no_telegram_id`;
          } else {
            await bot.api.sendMessage(Number(u.telegram_id), text, {
              parse_mode: "Markdown",
              disable_web_page_preview: true,
            });
            success = true;
          }
        }
      }
    } catch (err) {
      lastError = err.message?.slice(0, 250);
    }

    if (success) {
      await query(
        `UPDATE pending_notifications SET status = 'sent', sent_at = NOW() WHERE id = $1`,
        [row.id],
      );
    } else {
      const terminal = row.attempt_count >= MAX_ATTEMPTS;
      await query(
        `UPDATE pending_notifications
            SET status = $2, last_error = $3
          WHERE id = $1`,
        [row.id, terminal ? "failed" : "pending", lastError],
      );
      console.warn(`[notification-sender] delivery failed for id=${row.id} attempt=${row.attempt_count}: ${lastError}`);
    }
  }
}

export function startNotificationSender(bot) {
  if (_timer) return;
  console.log(`[notification-sender] armed — polling pending_notifications every ${POLL_INTERVAL_MS / 1000}s`);
  _timer = setInterval(() => {
    tick(bot).catch((err) => console.error("[notification-sender] tick threw:", err.message));
  }, POLL_INTERVAL_MS);
}

export function stopNotificationSender() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
