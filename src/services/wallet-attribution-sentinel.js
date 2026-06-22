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

// Cadence tightened from 30min -> 5min 2026-06-18 PM. With Layer 4
// auto-repair (PR #393), the sentinel now FIXES drift inline, so a
// faster tick = tighter window before the user sees "no active loans"
// on /repay after a fresh borrow. 5min is still cheap (one indexed
// SQL per tick). Operator-mandated. [[feedback_never_misattribute_loans]]
const POLL_INTERVAL_MS = Number(process.env.WALLET_ATTR_SENTINEL_MS) || 5 * 60_000;
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

  // LAYER 4 — auto-repair. Operator-mandated 2026-06-19 ("never misattribute").
  // The sentinel used to alert and wait for manual repair. Now it repairs
  // atomically and DMs the operator with what it fixed. Loans become
  // visible to their rightful owners within ONE tick instead of waiting
  // for human-in-the-loop. Each repair writes an audit row so the entire
  // history of mutations is reconstructable. [[feedback_never_misattribute_loans]]
  const repaired = [];
  const repairErrors = [];
  for (const r of rows) {
    try {
      await query("BEGIN");
      await query(
        `INSERT INTO loan_user_attribution_audit (loan_id, prev_user_id, new_user_id, reason, repaired_by, metadata)
         VALUES ($1, $2, $3, 'sentinel_auto_repair', 'wallet_attribution_sentinel',
                 jsonb_build_object('borrower_wallet', $4::text, 'program_id', $5::text))`,
        [r.id, r.current_uid, r.correct_uid, r.borrower_wallet, r.program_id],
      );
      await query(
        `UPDATE loans SET user_id = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3`,
        [r.correct_uid, r.id, r.current_uid],
      );
      await query("COMMIT");
      repaired.push(r);
    } catch (err) {
      await query("ROLLBACK").catch(() => {});
      repairErrors.push({ id: r.id, err: err?.message?.slice(0, 100) });
    }
  }

  if (shouldAlert || repaired.length > 0 || repairErrors.length > 0) {
    const sample = rows.slice(0, 12).map((r) => {
      const pool = r.program_id?.startsWith("B8AwYz") ? "V3"
                 : r.program_id?.startsWith("6wSpKA") ? "V2"
                 : r.program_id?.startsWith("4FEFPe") ? "V1"
                 : r.program_id?.startsWith("HA1hgv") ? "V4" : "?";
      const owed = (Number(r.owed_lamports) / 1e9).toFixed(2);
      const status = repaired.find((x) => x.id === r.id)
        ? "REPAIRED"
        : repairErrors.find((x) => x.id === r.id)
        ? "REPAIR_FAILED"
        : "DETECTED";
      return `  ${status} loan.id=${r.id} ${pool} ${owed}SOL user ${r.current_uid} -> ${r.correct_uid}`;
    }).join("\n");
    const more = rows.length > 12 ? `\n  ... and ${rows.length - 12} more` : "";
    const headline = repaired.length === count
      ? `[wallet-attr-sentinel] AUTO-REPAIRED — ${count} mis-attributed loan(s) fixed atomically.`
      : repaired.length > 0
      ? `[wallet-attr-sentinel] PARTIAL REPAIR — ${repaired.length}/${count} fixed; ${repairErrors.length} failed. Inspect logs.`
      : `[wallet-attr-sentinel] ALERT — ${count} active/overdue loan(s) attributed to the wrong user_id (auto-repair attempt failed).`;
    const msg = [
      headline,
      ``,
      `Affected:`,
      sample + more,
      ``,
      `Audit trail: SELECT * FROM loan_user_attribution_audit WHERE repaired_at > NOW() - INTERVAL '5 min';`,
      `Root-cause guidance: recent loan-recording path may have bypassed wallet-owner-resolver. Layer 3 (recordLoan pre-write guard) catches this at WRITE time; sentinel is Layer 4 (after-the-fact safety net).`,
    ].join("\n");
    await notifyAdmin(bot, msg, { parse_mode: undefined });
    lastAlertedAt = now;
    lastAlertedCount = count;
  }
  return { count, repaired: repaired.length, errors: repairErrors.length };
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
