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

/**
 * Render an "an agent did this" attribution line if the order's
 * source is agent_x402. Borrower needs to know whether they (via TG)
 * or an authorized agent took the action — and which agent, so they
 * can revoke if it wasn't expected.
 *
 * If source is 'tg' (or missing — older orders predate the field),
 * return null and let renderers omit the line entirely.
 */
function agentAttribution(p) {
  if (p.source !== "agent_x402") return null;
  const pk = p.source_agent_pubkey;
  if (!pk || typeof pk !== "string" || pk.length < 12) {
    return `Armed by an authorized agent.`;
  }
  return `Armed by your authorized agent \`${pk.slice(0, 8)}...${pk.slice(-4)}\`. Revoke with /agent_revoke if unexpected.`;
}

/**
 * Render the Layer 3 intervention DM. The bot's send-tick wraps this
 * with an inline keyboard since notification-sender is the only
 * place we have the TG client.
 */
function renderLimitCloseIntervention(p) {
  const agentLine = agentAttribution(p);
  const suggestedPct = (p.suggested_slippage_bps / 100).toFixed(2);
  const currentCapPct = (p.current_cap_bps / 100).toFixed(2);
  return [
    `*Limit-close needs your call* — order #${p.order_id}`,
    ``,
    `Trigger hit, but the swap can't fill within your cap.`,
    `Current cap: \`${currentCapPct}%\` slippage`,
    `Would clear at: \`${suggestedPct}%\` (current liquidity)`,
    ``,
    `Allow \`${suggestedPct}%\` to fill now, or wait for deeper liquidity.`,
    `(Decision window: 1 hour.)`,
    agentLine ? `` : null,
    agentLine,
  ].filter((s) => s !== null).join("\n");
}

function renderLimitCloseArmed(p) {
  const agentLine = agentAttribution(p);
  return [
    `*Limit-close armed* — order #${p.order_id}`,
    ``,
    `Loan: #${p.loan_id_chain}`,
    `Trigger: ${p.trigger_label}`,
    `Slippage: ${(p.slippage_bps / 100).toFixed(2)}%`,
    `Destination: ${p.sell_destination.toUpperCase()}`,
    agentLine ? `` : null,
    agentLine,
    ``,
    `I'll repay and sell automatically when the trigger fires.`,
  ].filter((s) => s !== null).join("\n");
}

function renderLimitCloseFired(p) {
  const agentLine = agentAttribution(p);
  return [
    `*Limit-close FIRED* — order #${p.order_id}`,
    ``,
    `Trigger: ${p.trigger_label} hit`,
    `Repaid: ${fmtSol(p.loan_owed_lamports)} SOL · [tx](https://solscan.io/tx/${p.tx_repay})`,
    `Sold: ${p.collateral_sold_human} ${p.collateral_symbol} → ${fmtSol(p.proceeds_lamports)} ${p.dest.toUpperCase()} · [tx](https://solscan.io/tx/${p.tx_swap})`,
    `Fee: ${fmtSol(p.fee_lamports)} ${p.dest.toUpperCase()} (1%)`,
    ``,
    `Net to your wallet: *${fmtSol(p.net_to_user_lamports)} ${p.dest.toUpperCase()}*`,
    agentLine ? `` : null,
    agentLine,
  ].filter((s) => s !== null).join("\n");
}

function renderLimitCloseFailed(p) {
  const agentLine = agentAttribution(p);
  return [
    `*Limit-close FAILED* — order #${p.order_id}`,
    ``,
    `Reason: ${p.reason}`,
    p.detail ? `Detail: ${p.detail}` : null,
    ``,
    `Your loan is *unchanged*. Set a new order with /limitclose or close manually with /repay.`,
    agentLine ? `` : null,
    agentLine,
  ].filter((s) => s !== null).join("\n");
}

function renderLimitCloseCancelled(p) {
  const agentLine = agentAttribution(p);
  return [
    `*Limit-close cancelled* — order #${p.order_id}`,
    ``,
    `Reason: ${p.reason}`,
    agentLine ? `` : null,
    agentLine,
  ].filter((s) => s !== null).join("\n");
}

const RENDERERS = {
  limit_close_armed:        renderLimitCloseArmed,
  limit_close_fired:        renderLimitCloseFired,
  limit_close_failed:       renderLimitCloseFailed,
  limit_close_cancelled:    renderLimitCloseCancelled,
  limit_close_intervention: renderLimitCloseIntervention,
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
            // Layer 3 — limit-close intervention needs an inline
            // keyboard so the borrower can tap a response. Keyboard
            // callback IDs encode the order id + the suggested
            // slippage_bps to widen to so the callback handler can
            // verify the action against the row.
            let extra = {};
            if (row.kind === "limit_close_intervention") {
              const { InlineKeyboard } = await import("grammy");
              const kb = new InlineKeyboard()
                .text(`Allow ${(row.payload.suggested_slippage_bps / 100).toFixed(1)}%`,
                      `lcint:approve:${row.payload.order_id}:${row.payload.suggested_slippage_bps}`)
                .row()
                .text("Wait",
                      `lcint:decline:${row.payload.order_id}`)
                .text("Cancel order",
                      `lcint:cancel:${row.payload.order_id}`);
              extra = { reply_markup: kb };
            }
            await bot.api.sendMessage(Number(u.telegram_id), text, {
              parse_mode: "Markdown",
              disable_web_page_preview: true,
              ...extra,
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
