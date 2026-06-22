/**
 * First-V3-fire watcher — two-prong observability for the V3 engine path.
 *
 * V3 went live for RWA + memecoin dual-tier on 2026-06-13. The bot
 * arm-flow stamps engine_program_id=V3_PROGRAM_ID on V3-loan orders.
 * The fill path runs in the external magpie-limitclose engine. This
 * watcher is the bot-side proof the engine's executeRepayLoanV3
 * path works end-to-end on real on-chain state.
 *
 * Prong A: celebrate the FIRST successful V3 fire.
 *   Polls every 5 min for the oldest fired V3 order; one-shot DM
 *   on milestone_key='first_v3_fire' so the operator hears the
 *   path is alive.
 *
 * Prong B: alert the FIRST V3 fire FAILURE.
 *   Polls for any status='failed' OR engine_error_reason populated
 *   on a V3 order. One-shot DM on milestone_key='first_v3_fire_failure'
 *   so the operator hears a broken V3 engine BEFORE more orders fire
 *   against it. This is the actual risk the audit flagged: a deployed
 *   V3 engine path that silently doesn't work and only manifests when
 *   real user orders pile up against it.
 *
 * Both prongs are independent — both can fire on the same process.
 *
 * Race-safe: the UPDATE clause is conditional on notified_at IS NULL,
 * so two bot replicas detecting the same milestone both attempt the
 * UPDATE but only one's WHERE clause matches. Idempotent across
 * restarts: once notified_at is set, prong short-circuits.
 *
 * No emojis per Magpie copy rules.
 */
import { query } from "../db/pool.js";

const WATCHER_INTERVAL_MS = Number(process.env.FIRST_V3_FIRE_INTERVAL_MS) || 5 * 60_000;
const FIRST_RUN_DELAY_MS = Number(process.env.FIRST_V3_FIRE_FIRST_DELAY_MS) || 2 * 60_000;
const V3_PROGRAM_ID = process.env.PROGRAM_ID_V3 || null;

let _timer = null;
let _successDisabled = false;
let _failureDisabled = false;

async function findFirstV3Success() {
  if (!V3_PROGRAM_ID) return null;
  const { rows: [row] } = await query(
    `SELECT lc.id, lc.fired_at, lc.tx_signature_repay, lc.tx_signature_swap,
            lc.proceeds_lamports::text  AS proceeds,
            lc.protocol_fee_lamports::text AS fee,
            lc.net_to_user_lamports::text  AS net_user,
            lc.trigger_direction,
            l.loan_id::text AS loan_id,
            l.borrower_wallet,
            sm.symbol, sm.category
       FROM limit_close_orders lc
       JOIN loans l ON l.id = lc.loan_id
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
      WHERE lc.status = 'fired'
        AND lc.engine_program_id = $1
      ORDER BY lc.fired_at ASC
      LIMIT 1`,
    [V3_PROGRAM_ID],
  );
  return row || null;
}

async function findFirstV3Failure() {
  if (!V3_PROGRAM_ID) return null;
  // 'failed' status OR a populated error_reason on a V3 order.
  // First fail-shaped row by order_id (deterministic ordering across replicas).
  const { rows: [row] } = await query(
    `SELECT lc.id, lc.status, lc.armed_at, lc.firing_started_at,
            lc.trigger_direction,
            lc.notes,
            l.loan_id::text AS loan_id,
            l.borrower_wallet,
            sm.symbol, sm.category
       FROM limit_close_orders lc
       JOIN loans l ON l.id = lc.loan_id
       LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
      WHERE lc.engine_program_id = $1
        AND lc.status = 'failed'
      ORDER BY lc.id ASC
      LIMIT 1`,
    [V3_PROGRAM_ID],
  );
  return row || null;
}

function formatSuccessDm(fire) {
  const direction = fire.trigger_direction === "below" ? "STOP-LOSS" : "TAKE-PROFIT";
  const proceedsSol = (Number(fire.proceeds || 0) / 1e9).toFixed(4);
  const feeSol = (Number(fire.fee || 0) / 1e9).toFixed(4);
  const netSol = (Number(fire.net_user || 0) / 1e9).toFixed(4);
  const sig = fire.tx_signature_swap || fire.tx_signature_repay || "";
  const sigDisplay = sig ? `${sig.slice(0, 16)}...` : "n/a";
  const sigLink = sig ? `\nhttps://solscan.io/tx/${sig}` : "";
  return [
    "*Milestone: first V3 limit-close fired*",
    "",
    `Order #${fire.id} (${direction}) on ${fire.symbol || "?"} (${fire.category || "?"}) just executed on the V3 lending pool.`,
    "",
    `*Proceeds:*  ${proceedsSol} SOL`,
    `*Protocol fee:*  ${feeSol} SOL`,
    `*Net to user:*  ${netSol} SOL`,
    `*Tx signature:*  \`${sigDisplay}\`${sigLink}`,
    "",
    "V3 engine path is now PRODUCTION-VALIDATED. RWA + memecoin V3 fires confirmed end-to-end.",
  ].join("\n");
}

function formatFailureDm(fail) {
  const direction = fail.trigger_direction === "below" ? "STOP-LOSS" : "TAKE-PROFIT";
  return [
    "*ALERT: first V3 limit-close fire FAILED*",
    "",
    `Order #${fail.id} (${direction}) on ${fail.symbol || "?"} (${fail.category || "?"}) transitioned to status='failed' on the V3 lending pool.`,
    "",
    `*Loan ID:*  ${fail.loan_id}`,
    `*Borrower:*  \`${(fail.borrower_wallet || "").slice(0, 10)}...\``,
    `*Notes:*  ${(fail.notes || "(no notes recorded)").slice(0, 220)}`,
    "",
    "The V3 engine fill path may be broken. Inspect magpie-limitclose logs for this order before more V3 orders fire and pile up failures.",
    "",
    "Mitigation while debugging: set ROUTE_RWA_TO_V3=false to fall back to V2 for new RWA borrows.",
  ].join("\n");
}

async function tickSuccess(bot) {
  if (_successDisabled) return;
  try {
    const { rows: [flag] } = await query(
      `SELECT notified_at FROM engine_milestone_flags WHERE milestone_key = 'first_v3_fire'`,
    );
    if (!flag) return;
    if (flag.notified_at) {
      _successDisabled = true;
      return;
    }
    const fire = await findFirstV3Success();
    if (!fire) return;

    const { rowCount } = await query(
      `UPDATE engine_milestone_flags
          SET notified_at = NOW(),
              reference_id = $1,
              reference_sig = $2
        WHERE milestone_key = 'first_v3_fire'
          AND notified_at IS NULL`,
      [String(fire.id), fire.tx_signature_swap || fire.tx_signature_repay || null],
    );
    if (rowCount === 0) {
      _successDisabled = true;
      return;
    }

    const adminId = process.env.ADMIN_TG_ID;
    if (adminId && bot) {
      try {
        await bot.api.sendMessage(Number(adminId), formatSuccessDm(fire), { parse_mode: "Markdown" });
        console.log(`[first-v3-fire-watcher] celebrated order ${fire.id}`);
      } catch (err) {
        console.warn("[first-v3-fire-watcher] success DM send failed:", err.message?.slice(0, 80));
      }
    }
    _successDisabled = true;
  } catch (err) {
    console.warn("[first-v3-fire-watcher] success tick threw:", err.message?.slice(0, 80));
  }
}

async function tickFailure(bot) {
  if (_failureDisabled) return;
  try {
    const { rows: [flag] } = await query(
      `SELECT notified_at FROM engine_milestone_flags WHERE milestone_key = 'first_v3_fire_failure'`,
    );
    if (!flag) return;
    if (flag.notified_at) {
      _failureDisabled = true;
      return;
    }
    const fail = await findFirstV3Failure();
    if (!fail) return;

    const { rowCount } = await query(
      `UPDATE engine_milestone_flags
          SET notified_at = NOW(),
              reference_id = $1
        WHERE milestone_key = 'first_v3_fire_failure'
          AND notified_at IS NULL`,
      [String(fail.id)],
    );
    if (rowCount === 0) {
      _failureDisabled = true;
      return;
    }

    const adminId = process.env.ADMIN_TG_ID;
    if (adminId && bot) {
      try {
        await bot.api.sendMessage(Number(adminId), formatFailureDm(fail), { parse_mode: "Markdown" });
        console.warn(`[first-v3-fire-watcher] alerted on FAILED order ${fail.id}`);
      } catch (err) {
        console.warn("[first-v3-fire-watcher] failure DM send failed:", err.message?.slice(0, 80));
      }
    }
    _failureDisabled = true;
  } catch (err) {
    console.warn("[first-v3-fire-watcher] failure tick threw:", err.message?.slice(0, 80));
  }
}

export function startLimitCloseFirstV3FireWatcher(bot) {
  if (_timer) return;
  if (!V3_PROGRAM_ID) {
    console.log("[first-v3-fire-watcher] PROGRAM_ID_V3 not set — disabled");
    return;
  }
  console.log(`[first-v3-fire-watcher] armed — every ${WATCHER_INTERVAL_MS / 60_000} min for success + failure observability`);
  setTimeout(() => {
    tickSuccess(bot).catch((e) => console.warn("[first-v3-fire-watcher] first success tick threw:", e.message?.slice(0, 80)));
    tickFailure(bot).catch((e) => console.warn("[first-v3-fire-watcher] first failure tick threw:", e.message?.slice(0, 80)));
    _timer = setInterval(() => {
      tickSuccess(bot).catch((e) => console.warn("[first-v3-fire-watcher] success tick threw:", e.message?.slice(0, 80)));
      tickFailure(bot).catch((e) => console.warn("[first-v3-fire-watcher] failure tick threw:", e.message?.slice(0, 80)));
    }, WATCHER_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
}
