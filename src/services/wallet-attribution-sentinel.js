/**
 * Wallet-attribution sentinel — periodic guard against the bug fixed
 * in PR #231 + #232.
 *
 * The class of bug: a wallet pubkey can have MULTIPLE rows in the
 * wallets table (site_native + later TG-imported), and a loan-recording
 * path can pick the WRONG user_id at write time. When that happens,
 * /repay /topup /extend etc. fail silently — the borrower's TG account
 * can't see the loan even though it's their wallet on chain.
 *
 * The resolver in src/services/wallet-owner-resolver.js is the canonical
 * fix going forward (used by every write path). This sentinel catches
 * any future drift — a code path we missed, a refactor that re-introduces
 * the bug, or a manual DB op that bypasses the resolver.
 *
 * Cadence: every 30 minutes (default; tunable via env). Cheap query —
 * scans loans where status IN ('active','overdue'), joins canonical
 * resolution, and counts mismatches.
 *
 * Alert policy:
 *   - First non-zero count → DM operator with affected loan ids + the
 *     correct user_id per row. Includes the SQL to apply if they want
 *     to repair manually (the sentinel itself NEVER mutates).
 *   - While count stays non-zero, re-DM at most every 6h.
 *   - When count returns to zero, send a CLEAR message.
 *
 * No emojis per Magpie copy rules.
 */

import { query } from "../db/pool.js";
import { getAdminId, notifyAdmin } from "./admin-notify.js";

const POLL_INTERVAL_MS = Number(process.env.WALLET_ATTR_SENTINEL_MS) || 30 * 60_000;
const ALERT_REPEAT_MS = 6 * 60 * 60 * 1000;

let lastAlertedAt = 0;
let lastAlertedCount = -1;

async function runOneCycle(bot) {
  // Identical resolver SQL to src/services/wallet-owner-resolver.js +
  // src/api/site-limit-close.js. If those rankings change, change here
  // too — the sentinel only catches drift it can detect against the
  // SAME ranking the writes use.
  const { rows } = await query(
    `WITH ranked AS (
       SELECT w.public_key, w.user_id,
              ROW_NUMBER() OVER (
                PARTITION BY w.public_key
                ORDER BY (u.telegram_id IS NOT NULL AND u.telegram_id > 0) DESC,
                         w.is_active DESC,
                         w.created_at DESC
              ) AS rn
         FROM wallets w
         JOIN users u ON u.id = w.user_id
     ),
     canonical AS (
       SELECT public_key, user_id AS canonical_user_id FROM ranked WHERE rn = 1
     )
     SELECT l.id, l.loan_id, l.user_id AS current_uid,
            c.canonical_user_id AS correct_uid,
            l.status, l.program_id, l.borrower_wallet,
            l.original_loan_amount_lamports::text AS owed_lamports
       FROM loans l
       JOIN canonical c ON c.public_key = l.borrower_wallet
      WHERE l.status IN ('active','overdue')
        AND l.user_id IS DISTINCT FROM c.canonical_user_id`,
  );
  const count = rows.length;
  const now = Date.now();

  if (count === 0) {
    if (lastAlertedCount > 0) {
      await notifyAdmin(
        bot,
        `[wallet-attr-sentinel] CLEAR — every active/overdue loan now matches its canonical TG-linked user_id.`,
        { parse_mode: undefined },
      );
      lastAlertedCount = 0;
      lastAlertedAt = 0;
    }
    return { count: 0 };
  }

  const shouldAlert =
    lastAlertedCount <= 0 ||
    now - lastAlertedAt > ALERT_REPEAT_MS ||
    count > lastAlertedCount * 1.5;

  if (shouldAlert) {
    const sample = rows.slice(0, 12).map((r) => {
      const pool = r.program_id?.startsWith("B8AwYz") ? "V3"
                 : r.program_id?.startsWith("6wSpKA") ? "V2"
                 : r.program_id?.startsWith("4FEFPe") ? "V1" : "?";
      const owed = (Number(r.owed_lamports) / 1e9).toFixed(2);
      return `  loan.id=${r.id} ${pool} ${owed}SOL user ${r.current_uid} -> ${r.correct_uid}`;
    }).join("\n");
    const more = rows.length > 12 ? `\n  ... and ${rows.length - 12} more` : "";
    const msg = [
      `[wallet-attr-sentinel] ALERT — ${count} active/overdue loan(s) attributed to the wrong user_id.`,
      `These loans are invisible in their owner's /repay et al. until repaired.`,
      ``,
      `Affected:`,
      sample + more,
      ``,
      `Likely root cause: a recent loan-recording path bypassed wallet-owner-resolver.js. Audit recent code changes that touch loans.user_id or wallets-to-user resolution.`,
      `Manual repair pattern: UPDATE loans SET user_id = <correct_uid> WHERE id = <loan_id>;`,
    ].join("\n");
    await notifyAdmin(bot, msg, { parse_mode: undefined });
    lastAlertedAt = now;
    lastAlertedCount = count;
  }
  return { count };
}

export function startWalletAttributionSentinel(bot) {
  if (!getAdminId()) {
    console.warn("[wallet-attr-sentinel] no ADMIN_TG_ID — sentinel will run but alerts will be silent");
  }
  setTimeout(async function tick() {
    try {
      await runOneCycle(bot);
    } catch (err) {
      console.error("[wallet-attr-sentinel] tick failed:", err?.message?.slice(0, 200));
    } finally {
      setTimeout(tick, POLL_INTERVAL_MS);
    }
  }, 90_000);
  console.log(`[wallet-attr-sentinel] sentinel armed (interval ${Math.round(POLL_INTERVAL_MS / 60_000)}min)`);
}
