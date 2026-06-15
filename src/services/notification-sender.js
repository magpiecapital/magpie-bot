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
  const direction = p.trigger_direction === "below" ? "stop" : "profit target";
  return [
    `*Auto-sell set up* — order #${p.order_id}`,
    ``,
    `Loan: #${p.loan_id_chain}`,
    `${direction === "stop" ? "Stop at" : "Sell when"}: ${p.trigger_label}`,
    `Slippage allowance: ${(p.slippage_bps / 100).toFixed(2)}%`,
    `We pay you in: ${p.sell_destination.toUpperCase()}`,
    agentLine ? `` : null,
    agentLine,
    ``,
    `When the target hits, we'll repay your loan and send the proceeds to your wallet automatically.`,
  ].filter((s) => s !== null).join("\n");
}

/**
 * Arm-attempt failure DM. Fired by limit-close-arm-core's wrapper on
 * EVERY failed armOrder() call, regardless of source (site / tg /
 * agent_x402). Forcing function: operator's 2026-06-15 V4 SPCX ladder
 * incident — the user thought they armed a ladder, the strike was
 * hit, no fire happened, no signal anywhere on the dashboard. Now
 * they get the truth in their DMs within seconds.
 */
function renderLimitCloseArmFailed(p) {
  // Human-readable explanation for known error codes. Falls back to
  // the raw error_code + detail so we never silently drop info.
  const why = humanizeArmFailure(p.error_code, p.error_detail);

  // Format the target the user tried to arm, when we have enough to
  // reconstruct it. Otherwise a generic "your auto-sell".
  const target = formatAttemptedTarget(p);

  const dirLabel = p.direction === "below" ? "stop-loss" : "take-profit";
  const sliceTxt = p.slice_pct && p.slice_pct < 10000
    ? ` (${(p.slice_pct / 100).toFixed(0)}% slice)`
    : "";

  return [
    `*Auto-sell didn't arm*`,
    ``,
    `What you tried to set: ${target}${sliceTxt} — ${dirLabel}`,
    p.loan_id_chain ? `Loan: #${p.loan_id_chain}` : null,
    ``,
    `Why it failed: ${why}`,
    ``,
    `Nothing is armed on the chain. Tap "Try again" in the dashboard or DM me ("/help") if you'd like a walk-through.`,
  ].filter((s) => s !== null).join("\n");
}

function formatAttemptedTarget(p) {
  if (!p.trigger_kind || p.trigger_value_micro == null) return "your auto-sell";
  const n = Number(p.trigger_value_micro);
  if (!Number.isFinite(n)) return "your auto-sell";
  if (p.trigger_kind === "mc_usd") {
    const usd = n / 1e6;
    if (usd >= 1e9) return `$${(usd / 1e9).toFixed(2)}B mc`;
    if (usd >= 1e6) return `$${(usd / 1e6).toFixed(2)}M mc`;
    if (usd >= 1e3) return `$${(usd / 1e3).toFixed(2)}K mc`;
    return `$${usd.toFixed(2)} mc`;
  }
  if (p.trigger_kind === "price_usd") {
    const usd = n / 1e6;
    if (usd >= 1) return `$${usd.toFixed(2)}`;
    if (usd >= 0.01) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(8)}`;
  }
  return `${(n / 1e9).toFixed(6)} SOL`;
}

function humanizeArmFailure(code, detail) {
  switch (code) {
    case "loan_not_found_for_user":
      return "We couldn't find that loan on your account. If you just borrowed, give it ~5 seconds and try again — the loan may not have propagated yet.";
    case "loan_not_active":
      return "That loan isn't active anymore. It may have been repaid or liquidated.";
    case "loan_below_minimum_size":
      return "Loans under 1 SOL aren't eligible for auto-sells right now.";
    case "collateral_not_enabled":
      return "This collateral token is currently disabled for new auto-sells. Ping @MagpieLoans if you think this is a mistake.";
    case "take_profit_already_armed":
    case "stop_loss_already_armed":
    case "loan_already_has_active_order":
      return "You already have an active auto-sell on this loan in this direction. Cancel the existing one first if you want to change it.";
    case "trigger_would_fire_immediately":
      return "Your target is on the wrong side of the current price — it would fire as soon as it armed. Pick a target above the current price for take-profit (or below it for stop-loss).";
    case "user_concurrency_cap_reached":
      return "You've hit the per-user cap of 10 active auto-sells. Cancel an existing one and try again.";
    case "invalid_slippage_bps":
      return "The slippage allowance was outside the protocol bounds.";
    case "invalid_slice_pct":
      return "Ladder slice has to add up correctly — each leg between 0.01% and 100%, total ≤ 100%.";
    case "invalid_trigger_value":
    case "trigger_value_out_of_range":
      return "The price target looked malformed. Try entering it as a USD value (e.g. \"180\") or a market-cap (\"145M mc\").";
    case "invalid_trailing_distance_bps":
      return "Trailing distance must be between 0.5% and 50%.";
    case "trailing_only_valid_on_stop_loss":
      return "Trailing distance only applies to stop-loss orders, not take-profit.";
    case "insert_failed":
      return `The database refused the order at the last step. Detail: ${detail || "(none provided)"}`;
    case "exception":
      return `An unexpected error happened on the server. Detail: ${detail || "(none provided)"}`;
    default:
      return code
        ? `${code}${detail ? ` — ${detail}` : ""}`
        : "Unknown failure (we logged it).";
  }
}

/**
 * V4 fire DM — fundamentally different message from legacy fire.
 *
 * Legacy V1/V3 fire: engine repaid loan + sold collateral + sent SOL to
 * user wallet. Loan closed.
 *
 * V4 fire: engine converted slice_bps × original collateral in-vault.
 * Loan STAYS ACTIVE. SOL accumulates in per-loan sol_proceeds_vault.
 * User claims at repay (vault SOL + remaining SPL flow back atomically).
 *
 * Critical UX: don't tell the V4 user their loan closed. It didn't.
 * Pip + dashboard + this DM all need to consistently teach the in-vault
 * model.
 */
function renderLimitCloseV4Fired(p) {
  const agentLine = agentAttribution(p);
  const dirLabel = p.trigger_direction === "below"
    ? "stop-loss"
    : p.trigger_direction === "above"
      ? "take-profit"
      : "auto-sell";
  const slicePct = p.slice_bps ? (p.slice_bps / 100).toFixed(0) : null;
  const netSol = fmtSol(p.sol_received_net);
  const feeSol = fmtSol(p.protocol_fee);
  const cumSol = fmtSol(p.total_sol_proceeds);
  const remainingSpl = p.remaining_collateral
    ? `${p.remaining_collateral} raw (left in vault)`
    : null;
  const lines = [
    `*${dirLabel.toUpperCase()} fired — V4 in-vault sale* (order #${p.order_id})`,
    "",
    slicePct
      ? `Sold ${slicePct}% of original collateral. SOL deposited *inside your loan*, not your wallet.`
      : `Slice sold. SOL deposited *inside your loan*, not your wallet.`,
    "",
    `*This leg:*  +${netSol} SOL (fee ${feeSol} · 1%)`,
    `*Vault total (cumulative):*  ${cumSol} SOL`,
    p.auto_sells_fired ? `*Auto-sells fired so far:*  ${p.auto_sells_fired}` : null,
    p.tx_signature ? `[View tx](https://solscan.io/tx/${p.tx_signature})` : null,
    "",
    `Loan stays *Active* — you decide when to close. When you /repay, the vault SOL flows back to your wallet *along with* any remaining collateral, in the same tx.`,
    "",
    `_Heads up: V4 repay needs ~owed-amount liquid SOL in your wallet to fund the close. The vault SOL flows back in the same tx but doesn't pre-pay the loan._`,
    agentLine ? "" : null,
    agentLine,
  ].filter((s) => s !== null);
  return lines.join("\n");
}

function renderLimitCloseFired(p) {
  const agentLine = agentAttribution(p);
  // Headline switches by direction so the user immediately knows whether
  // their profit target or their stop hit. Falls back to the generic
  // "Auto-sell done" if direction wasn't included in the payload.
  let headline;
  if (p.trigger_direction === "above") {
    headline = `*Auto-sell DONE — profit target hit* (order #${p.order_id})`;
  } else if (p.trigger_direction === "below") {
    headline = `*Auto-sell DONE — stop triggered* (order #${p.order_id})`;
  } else {
    headline = `*Auto-sell DONE* — order #${p.order_id}`;
  }
  return [
    headline,
    ``,
    `Target: ${p.trigger_label}`,
    `Repaid your loan: ${fmtSol(p.loan_owed_lamports)} SOL · [view tx](https://solscan.io/tx/${p.tx_repay})`,
    `Sold ${p.collateral_sold_human} ${p.collateral_symbol} → ${fmtSol(p.proceeds_lamports)} ${p.dest.toUpperCase()} · [view tx](https://solscan.io/tx/${p.tx_swap})`,
    `Protocol fee: ${fmtSol(p.fee_lamports)} ${p.dest.toUpperCase()} (1%)`,
    ``,
    `*You received: ${fmtSol(p.net_to_user_lamports)} ${p.dest.toUpperCase()}* — it's in your wallet now.`,
    agentLine ? `` : null,
    agentLine,
  ].filter((s) => s !== null).join("\n");
}

// Translates engine failure reason codes into one-line plain-language
// explanations. Falls back to the raw code for unknown reasons so we
// never silently drop information.
function humanizeFailureReason(reason) {
  switch (reason) {
    case "max_retries_exceeded":
      return "We retried for ~5 minutes, escalating slippage toward your cap each time, but couldn't fill within your limit. Usually means liquidity dried up.";
    case "wallet_changed_since_borrow":
      return "The wallet that opened this loan no longer holds the collateral. Limit orders only fire from the original borrower wallet.";
    case "no_collateral_in_ata_post_repay":
      return "The repay landed but the collateral wasn't where we expected at sell time — likely moved out mid-trigger.";
    case "swap_failed_collateral_in_wallet":
      return "The repay landed but the sell failed. The collateral is back in your wallet, ready to sell manually or via a fresh limit order.";
    case "twap_window_exceeded":
      return "We sliced the sell to fit your slippage cap, but the slow-trickle window ran out before all chunks filled.";
    case "twap_window_exceeded_partial":
      return "Some TWAP chunks filled, but the window expired before completing the rest. Check /positions for the partial state.";
    case "wallet_changed_during_twap":
      return "The wallet changed mid-TWAP. We stopped the slicing to protect remaining collateral.";
    // V4-specific reasons (2026-06-15) — surface human copy instead of
    // raw codes so V4 users aren't staring at v4_cross_source_*.
    case "v4_quote_failed":
      return "Jupiter routing for that slice failed — usually transient. We'll auto-retry on the next tick. No action needed.";
    case "v4_cross_source_disagreement_at_fire_quote":
      return "Two price sources disagreed at fire time, so we held off as a safety check. Likely a brief Jupiter routing imbalance. We'll re-check on the next tick.";
    case "v4_cross_source_recheck_failed":
      return "Couldn't get a clean cross-source price read at fire time. We're fail-closed on this — won't fire against a single source. Will retry shortly.";
    case "v4_engine_program_id_mismatch":
      return "The order's engine config doesn't match the loan's program — we refused to fire to avoid hitting the wrong pool. This needs operator review.";
    case "v4_convert_failed":
    case "v4_convert_failed_persistent":
      return "The in-vault convert tx itself failed on-chain. Most often this is a slippage cap that's tighter than current market conditions. Widen the slippage or wait for a calmer window.";
    default:
      return null; // unknown — caller falls back to raw reason line
  }
}

function renderLimitCloseFailed(p) {
  const agentLine = agentAttribution(p);
  const friendly = humanizeFailureReason(p.reason);
  return [
    `*Auto-sell didn't go through* — order #${p.order_id}`,
    ``,
    friendly ? friendly : `Reason: ${p.reason}`,
    p.detail ? `Detail: ${p.detail}` : null,
    ``,
    `Your loan is *unchanged*. You can set a new auto-sell with /limitclose, or repay manually with /repay.`,
    agentLine ? `` : null,
    agentLine,
  ].filter((s) => s !== null).join("\n");
}

// Engine borrower-balance pre-check (2026-06-13 P0). Soft-fail: the
// order is still ARMED — user just needs to fund the wallet and the
// next tick will re-evaluate. Tell them the exact amount + destination.
function renderLimitCloseActionRequired(p) {
  if (p?.reason === "borrower_balance_below_owed") {
    return [
      `⚠️ *Limit-close order #${p.order_id} — action needed*`,
      ``,
      `Your trigger hit, but your wallet doesn't have enough SOL for the loan repay right now.`,
      ``,
      `*Needed:* ${p.required_sol} SOL · *In wallet:* ${p.current_sol} SOL`,
      `*Send:* ${p.shortfall_sol} SOL`,
      ``,
      `Send to:`,
      `\`${p.wallet}\``,
      ``,
      `Once funded, the engine retries automatically on the next tick (~30s) — no need to re-arm.`,
      ``,
      `_Why this happens: the on-chain repay step requires you to hold the original loan amount in native SOL at execution time. Most users withdraw their borrow shortly after taking it out. Topping back up unblocks the order._`,
    ].join("\n");
  }
  // Generic fallback for future action_required reasons.
  return [
    `⚠️ *Limit-close order #${p.order_id} — action needed*`,
    ``,
    `Reason: ${p?.reason || "unknown"}`,
    p?.action ? `Action: ${p.action}` : null,
  ].filter(Boolean).join("\n");
}

// Transparency DM emitted by the engine the FIRST time it auto-escalates
// slippage on an order. Users would otherwise see nothing happen between
// trigger-hit and final fire/fail — this confirms the engine is actively
// working and shows the new slippage so they can sanity-check it against
// their cap. Subsequent escalations are silent (one DM per order).
function renderLimitCloseRetrying(p) {
  const prevPct = (Number(p.previous_slippage_bps) / 100).toFixed(2);
  const newPct = (Number(p.new_slippage_bps) / 100).toFixed(2);
  const capPct = p.max_slippage_bps_cap != null
    ? (Number(p.max_slippage_bps_cap) / 100).toFixed(2)
    : null;
  return [
    `*Working on your auto-sell — order #${p.order_id}*`,
    "",
    `Your target just hit. The first sell would have exceeded your slippage allowance, so we're retrying with a slightly wider one.`,
    "",
    `*Slippage:* ${prevPct}% → ${newPct}%${capPct ? ` _(your cap: ${capPct}%)_` : ""}`,
    "",
    `We auto-retry every ~30 seconds, stepping the slippage up each time until either the sell goes through or we hit your cap. No action needed — we'll DM you the receipt when it lands.`,
    "",
    `_If the price drops back below your target before we fill, the order stays armed and waits for the next move._`,
  ].join("\n");
}

function renderLimitCloseCancelled(p) {
  const agentLine = agentAttribution(p);
  return [
    `*Auto-sell cancelled* — order #${p.order_id}`,
    ``,
    `Reason: ${p.reason}`,
    agentLine ? `` : null,
    agentLine,
  ].filter((s) => s !== null).join("\n");
}

// Pip-proactive payload renderer. The upside watcher pre-renders the
// full text into payload.text, so we just pass it through. Keeping the
// rendering server-side (in the watcher) lets the watcher own the
// economic numbers + threshold copy without leaking renderer details.
function renderPipUpsideAlert(p) {
  return p?.text || "";
}

function renderLimitCloseStalenessNudge(p) {
  const dirLabel = p.trigger_direction === "below" ? "stop-loss" : "take-profit";
  return [
    `*Quick check on a limit order*`,
    "",
    `Your ${dirLabel} order #${p.order_id} on ${p.collateral_symbol} has been armed for ${p.days_old} days and the trigger is roughly ${p.distance_pct}% from current price.`,
    "",
    `It might still be the plan — or you might have set it and forgotten. Want to keep it active, or cancel and free the slot?`,
    "",
    `_This is a one-time nudge — we won't ask again unless the order sits another month._`,
  ].join("\n");
}

function renderLimitCloseNearTrigger(p) {
  const dirLabel = p.trigger_direction === "below" ? "stop-loss" : "take-profit";
  const moveDir  = p.trigger_direction === "below" ? "drops" : "moves up";
  const v4ProgramId = process.env.PROGRAM_ID_V4 || null;
  const isV4 = !!v4ProgramId && p.engine_program_id === v4ProgramId;
  const owedSol = p.owed_lamports
    ? (Number(p.owed_lamports) / 1e9).toFixed(3)
    : null;
  const fireAction = isV4
    ? "the engine will sell that slice on-chain and accumulate the SOL inside your loan"
    : "the engine will repay the loan and sell your collateral";
  const lines = [
    `*Your ${dirLabel} is close to firing*`,
    "",
    `${p.collateral_symbol} is within ~${p.distance_pct}% of your trigger on order #${p.order_id}. If price ${moveDir} a touch more, ${fireAction}.`,
  ];
  if (isV4 && owedSol) {
    lines.push(
      "",
      `*Heads up:* this loan is on V4 (in-vault auto-sell). When you eventually decide to close, you'll need *~${owedSol} SOL liquid* in your wallet — the sell proceeds accumulate inside the loan and flow back to you at repay, but they don't pre-pay the loan itself.`,
    );
  }
  lines.push(
    "",
    `If your plan changed, you can /modify ${p.order_id} (tighten or widen the trigger) or /cancel ${p.order_id} now. Otherwise sit tight — we've got it.`,
    "",
    `_One-time nudge per arm — you won't see this again until you re-arm or modify._`,
  );
  return lines.join("\n");
}

function renderEnginePreflightFailed(p) {
  const failures = Array.isArray(p?.failures) ? p.failures : [];
  const lines = [
    "*Limit-close engine refused to start*",
    "",
    "The engine ran its preflight self-test on boot and failed at least one check, so the watcher is not armed. Until this is resolved, no limit-close orders will fire.",
    "",
    "*Failures:*",
    ...failures.map((f) => `• \`${f.name}\` — ${f.detail || "no detail"}`),
    "",
    p?.hostname ? `_Host:_ \`${p.hostname}\`` : null,
    p?.checked_at ? `_At:_ \`${p.checked_at}\`` : null,
    "",
    "Fix the underlying issue (env, DB, RPC, keypair) and redeploy. Railway will restart the engine and rerun the preflight automatically.",
  ].filter((l) => l !== null);
  return lines.join("\n");
}

const RENDERERS = {
  limit_close_armed:        renderLimitCloseArmed,
  limit_close_arm_failed:   renderLimitCloseArmFailed,
  limit_close_fired:           renderLimitCloseFired,
  limit_close_v4_fired:        renderLimitCloseV4Fired,
  limit_close_failed:          renderLimitCloseFailed,
  limit_close_cancelled:       renderLimitCloseCancelled,
  limit_close_action_required: renderLimitCloseActionRequired,
  limit_close_retrying:        renderLimitCloseRetrying,
  limit_close_intervention: renderLimitCloseIntervention,
  limit_close_staleness_nudge: renderLimitCloseStalenessNudge,
  limit_close_near_trigger:    renderLimitCloseNearTrigger,
  engine_preflight_failed:  renderEnginePreflightFailed,
  pip_upside_alert:         renderPipUpsideAlert,
  // Downside alert reuses the same renderer — the watcher pre-renders
  // the entire DM body into payload.text, identical contract.
  pip_downside_alert:       renderPipUpsideAlert,
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
            } else if (row.kind === "limit_close_staleness_nudge") {
              const { InlineKeyboard } = await import("grammy");
              const kb = new InlineKeyboard()
                .text("Keep active", `lcstale:keep:${row.payload.order_id}`)
                .text("Cancel order", `lcstale:cancel:${row.payload.order_id}`);
              extra = { reply_markup: kb };
            } else if (row.kind === "limit_close_retrying") {
              // Lets the user bail mid-retry if they no longer want the
              // engine to keep escalating. Cancel is hard-cancel — order
              // moves to status='cancelled'. The callback handler is in
              // src/index.js under bot.callbackQuery("lcret:cancel:...").
              const { InlineKeyboard } = await import("grammy");
              const kb = new InlineKeyboard()
                .text("Cancel this order", `lcret:cancel:${row.payload.order_id}`);
              extra = { reply_markup: kb };
            } else if (row.kind === "limit_close_fired") {
              // Receipt-confirmation keyboard. Solscan links are already
              // inline in the body, but tap-once buttons are friendlier
              // for verifying proceeds on phones. Dashboard button takes
              // user to past-loans where they can see the full receipt.
              const { InlineKeyboard } = await import("grammy");
              const kb = new InlineKeyboard();
              if (row.payload?.tx_swap) {
                kb.url("View sale tx", `https://solscan.io/tx/${row.payload.tx_swap}`);
              }
              if (row.payload?.tx_repay) {
                kb.url("View repay tx", `https://solscan.io/tx/${row.payload.tx_repay}`);
              }
              kb.row().url("Open dashboard", "https://www.magpie.capital/dashboard");
              extra = { reply_markup: kb };
            } else if (row.kind === "limit_close_v4_fired") {
              // V4 fire — single tx (convert_collateral_slice). User's
              // primary action is to either keep waiting (more legs may
              // fire) or repay now to claim the vault SOL. Give them a
              // tap to verify the tx + a path to the loan management UI.
              const { InlineKeyboard } = await import("grammy");
              const kb = new InlineKeyboard();
              if (row.payload?.tx_signature) {
                kb.url("View tx", `https://solscan.io/tx/${row.payload.tx_signature}`);
              }
              kb.row().url("Open loan", "https://www.magpie.capital/dashboard");
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
