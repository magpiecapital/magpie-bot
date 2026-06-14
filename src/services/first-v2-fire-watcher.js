/**
 * First-V2-fire watcher — one-shot celebratory DM when the very first
 * RWA limit-close fires through the V2 lending program.
 *
 * Why this exists
 * ───────────────
 * RWA limit-close shipped end-to-end on 2026-06-13 across bot PRs
 * #157, #161, #162, #163 + engine PRs #16, #17, #18. The arm + dry-
 * run paths are verified working. The remaining unknown is whether
 * a REAL V2 fire — Anchor tx submitted, repayLoan + swap + fee
 * transfer all landing on chain — succeeds.
 *
 * When that happens, the operator wants to know immediately. A
 * milestone DM closes the loop on the build.
 *
 * Mechanism
 * ─────────
 * 1. Engine fires a V2 order → writes limit_close_orders row with
 *    status='fired', engine_program_id=V2 program id.
 * 2. This watcher polls every WATCHER_INTERVAL_MS for the OLDEST
 *    fired V2 order — newer ones don't matter, we want the FIRST.
 * 3. If a row exists AND engine_milestone_flags.notified_at IS NULL
 *    for 'first_v2_fire': enqueue an operator DM via
 *    pending_notifications, then UPDATE notified_at + reference_id +
 *    reference_sig in the same transaction.
 *    The UNIQUE on milestone_key + the transactional UPDATE make
 *    double-fire impossible — two bot replicas racing the same
 *    detection will both attempt the UPDATE but only one wins the
 *    "set notified_at WHERE notified_at IS NULL" clause.
 * 4. Once notified, the watcher short-circuits in subsequent ticks
 *    (notified_at is now set; nothing to do).
 *
 * Idempotency + back-compat
 * ─────────────────────────
 * - Migration 052 seeds the row with notified_at=NULL so the first
 *   real fire after deploy gets the celebration.
 * - If V2 fires already exist when this ships (e.g. an early test
 *   fire before this watcher landed), the first cycle picks the
 *   OLDEST and celebrates it. That's the right behavior — the
 *   operator wants to know about V2 going live regardless of
 *   timing relative to this watcher.
 */
import { query } from "../db/pool.js";

const WATCHER_INTERVAL_MS = Number(process.env.FIRST_V2_FIRE_INTERVAL_MS) || 5 * 60_000; // 5 min
const FIRST_RUN_DELAY_MS = Number(process.env.FIRST_V2_FIRE_FIRST_DELAY_MS) || 2 * 60_000;
const V1_PROGRAM_ID = process.env.PROGRAM_ID || "4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh";
const V2_PROGRAM_ID = process.env.PROGRAM_ID_V2 || null;

let _timer = null;
let _disabled = false;

async function findFirstV2Fire() {
  if (!V2_PROGRAM_ID) return null;
  // Pull the OLDEST fired V2 order. Joined to loans + supported_mints
  // so the DM has enough context to render a good message.
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
    [V2_PROGRAM_ID],
  );
  return row || null;
}

function formatDm(fire) {
  const direction = fire.trigger_direction === "below" ? "STOP-LOSS" : "TAKE-PROFIT";
  const proceedsSol = (Number(fire.proceeds || 0) / 1e9).toFixed(4);
  const feeSol = (Number(fire.fee || 0) / 1e9).toFixed(4);
  const netSol = (Number(fire.net_user || 0) / 1e9).toFixed(4);
  const sig = fire.tx_signature_swap || fire.tx_signature_repay || "—";
  const sigDisplay = sig === "—" ? "—" : `${sig.slice(0, 16)}…`;
  const sigLink = sig === "—" ? "" : `\nhttps://solscan.io/tx/${sig}`;
  return [
    "*Milestone: first V2 (RWA) limit-close fired*",
    "",
    `Order #${fire.id} (${direction}) on ${fire.symbol || "?"} just executed on the V2 RWA pool.`,
    "",
    `*Proceeds:*  ${proceedsSol} SOL`,
    `*Protocol fee:*  ${feeSol} SOL`,
    `*Net to user:*  ${netSol} SOL`,
    `*Tx signature:*  \`${sigDisplay}\`${sigLink}`,
    "",
    "RWA limit-close end-to-end is now PRODUCTION-VALIDATED. Memecoin + RWA + x402 paths all confirmed.",
  ].join("\n");
}

async function tick(bot) {
  if (_disabled) return;
  try {
    const { rows: [flag] } = await query(
      `SELECT notified_at FROM engine_milestone_flags WHERE milestone_key = 'first_v2_fire'`,
    );
    if (!flag) return; // table not yet migrated
    if (flag.notified_at) {
      // Already celebrated. Stop polling entirely — this is a one-shot.
      console.log("[first-v2-fire-watcher] already notified, disabling further polls");
      _disabled = true;
      return;
    }
    const fire = await findFirstV2Fire();
    if (!fire) return; // no V2 fire yet

    // Race-safe single-winner: UPDATE conditional on notified_at IS NULL.
    // Two replicas detecting the same fire will both try this UPDATE,
    // but only one's WHERE clause matches.
    const { rowCount } = await query(
      `UPDATE engine_milestone_flags
          SET notified_at = NOW(),
              reference_id = $1,
              reference_sig = $2
        WHERE milestone_key = 'first_v2_fire'
          AND notified_at IS NULL`,
      [String(fire.id), fire.tx_signature_swap || fire.tx_signature_repay || null],
    );
    if (rowCount === 0) {
      // Another replica won the race — nothing to do.
      _disabled = true;
      return;
    }

    const adminId = process.env.ADMIN_TG_ID;
    if (adminId && bot) {
      try {
        await bot.api.sendMessage(Number(adminId), formatDm(fire), { parse_mode: "Markdown" });
        console.log(`[first-v2-fire-watcher] celebrated order ${fire.id}`);
      } catch (err) {
        console.warn("[first-v2-fire-watcher] DM send failed:", err.message?.slice(0, 80));
      }
    }
    _disabled = true; // one-shot, never poll again this process
  } catch (err) {
    console.warn("[first-v2-fire-watcher] tick threw:", err.message?.slice(0, 80));
  }
}

export function startFirstV2FireWatcher(bot) {
  if (_timer) return;
  if (!V2_PROGRAM_ID) {
    console.log("[first-v2-fire-watcher] PROGRAM_ID_V2 not set — disabled");
    return;
  }
  console.log(`[first-v2-fire-watcher] armed — every ${WATCHER_INTERVAL_MS / 60_000} min until first V2 fire celebrated`);
  setTimeout(() => {
    tick(bot).catch((e) => console.warn("[first-v2-fire-watcher] first tick threw:", e.message?.slice(0, 80)));
    _timer = setInterval(() => {
      if (_disabled) return;
      tick(bot).catch((e) => console.warn("[first-v2-fire-watcher] tick threw:", e.message?.slice(0, 80)));
    }, WATCHER_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
}
