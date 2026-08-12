/**
 * Loan-deadline watcher.
 *
 * Sends DM warnings to borrowers at two checkpoints:
 *   - 24h before due → first warning (warned_24h_at)
 *   -  6h before due → urgent follow-up (warned_6h_at)
 *
 * Each warning is sent at most once per loan. Includes inline "Repay now"
 * button that piggybacks on the existing `/repay` callback-query handler.
 *
 * UNDELIVERABLE BORROWERS (2026-08-12). A warning is only marked sent once the
 * DM actually goes through — which is right, but it used to mean a borrower who
 * had blocked the bot was retried every 60s until expiry, was never warned, and
 * nobody found out. Production logs show `400: Bad Request: chat not found`
 * against live loans, and EVERY loan has a non-null user_id, so a linked
 * account does not imply a reachable one.
 *
 * Two independent layers now cover that, because one is not enough:
 *
 *   1. CLASSIFY — `isPermanentDeliveryFailure()` recognises rejections that can
 *      never succeed, records them on the loan, and backs the retry off from
 *      every minute to hourly (still retrying, so a borrower who unblocks the
 *      bot is picked up within the hour).
 *
 *   2. BACKSTOP — `checkUnwarnedNearDue()` alerts the operator about ANY active
 *      loan approaching its deadline with no delivered warning, whatever the
 *      cause. It does not consult the classifier, so it still fires if the
 *      classifier is wrong, if the bot was down through the window, or if the
 *      failure is something nobody anticipated.
 *
 * The thing being defended is specific: nobody should lose collateral without
 * having been told it was about to happen, and if we cannot tell them, a human
 * needs to know that.
 */
import { InlineKeyboard } from "grammy";
import { query } from "../db/pool.js";
import { getPrefs } from "./prefs.js";
import { isPermanentDeliveryFailure, deliveryFailureReason } from "./telegram-delivery.js";
import { notifyAdmin } from "./admin-notify.js";

const POLL_INTERVAL_MS = Number(process.env.LOAN_WATCH_MS) || 60_000;

/**
 * How long to wait before re-attempting a DM that Telegram called permanently
 * undeliverable. Not "never again" — borrowers unblock bots — but not every
 * 60s either, which is what produced the log flood.
 */
const UNDELIVERABLE_RETRY = "1 hour";

/**
 * Backstop window: alert the operator when an active loan is this close to due
 * with no warning delivered. Sits inside the 6h checkpoint so there is still
 * time for a human to do something.
 */
const BACKSTOP_HOURS = Number(process.env.LOAN_WARN_BACKSTOP_HOURS) || 3;

/**
 * Earlier backstop for borrowers we know are STRUCTURALLY unreachable.
 *
 * A site-native account is auto-bootstrapped with a synthetic NEGATIVE
 * telegram_id derived from the wallet (see api/account-link.js), and no real
 * Telegram account exists behind it. Every DM to one fails `chat not found`.
 *
 * That is knowable the moment the loan is created — it is not a delivery
 * failure we discover late. Waiting until 3h before the deadline to mention it
 * wastes the entire window in which a human could actually do something. These
 * get flagged a full day out instead.
 *
 * Real TG users (positive id) keep the 3h window: for them a missing warning
 * means something went wrong recently, and alerting a day early on what is
 * usually a transient blip would just train the operator to ignore it.
 */
const BACKSTOP_UNREACHABLE_HOURS =
  Number(process.env.LOAN_WARN_BACKSTOP_UNREACHABLE_HOURS) || 24;

/**
 * Deliver one warning DM and record the outcome honestly.
 *
 * Returns nothing and never throws — the watcher must survive any single
 * borrower being unreachable.
 *
 * @param {import("grammy").Bot} bot
 * @param {{id:number, loan_id:string, telegram_id:string|number, borrower_wallet:string}} row
 * @param {"warned_24h_at"|"warned_6h_at"} column
 * @param {string} msg
 * @param {InlineKeyboard} kb
 */
async function deliverWarning(bot, row, column, msg, kb) {
  try {
    await bot.api.sendMessage(row.telegram_id, msg, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: kb,
    });
    // Clear any prior undeliverable mark — they are reachable again.
    await query(
      `UPDATE loans
          SET ${column} = NOW(),
              warn_undeliverable_at = NULL,
              warn_undeliverable_reason = NULL
        WHERE id = $1`,
      [row.id],
    );
    return;
  } catch (err) {
    const reason = deliveryFailureReason(err);
    const permanent = isPermanentDeliveryFailure(err);
    console.error(
      `[loan-watcher] ${column} DM failed for loan ${row.loan_id} ` +
        `(${permanent ? "PERMANENT" : "transient"}): ${reason}`,
    );

    if (!permanent) return; // plain retry next tick — nothing to record

    // Record it. Deliberately does NOT set `column`: we did not warn them, and
    // writing "warned" here would launder a failure into the audit trail. The
    // queries below skip recently-undeliverable rows instead.
    await query(
      `UPDATE loans
          SET warn_undeliverable_at = NOW(),
              warn_undeliverable_reason = $2
        WHERE id = $1`,
      [row.id, reason],
    ).catch((e) => console.error("[loan-watcher] undeliverable write failed:", e.message));
  }
}

/**
 * Backstop — the layer that does not trust anything above it.
 *
 * Any active loan inside the backstop window with no 6h warning delivered gets
 * the operator told, once, regardless of why. Fails open: a broken backstop
 * must never stop warnings from going out.
 */
async function checkUnwarnedNearDue(bot) {
  try {
    const { rows } = await query(
      `SELECT l.id, l.loan_id, l.borrower_wallet, l.due_timestamp,
              l.warn_undeliverable_reason,
              l.original_loan_amount_lamports,
              (u.telegram_id::bigint < 0) AS structurally_unreachable
         -- LEFT so a loan with a missing/broken user row still gets a backstop.
         -- An inner join would silently drop exactly the rows most likely to be
         -- wrong, and losing coverage is the one thing this layer must not do.
         -- NULL telegram_id falls through the CASE to the ordinary 3h window.
         FROM loans l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.status = 'active'
          AND l.warned_6h_at IS NULL
          AND l.warn_escalated_at IS NULL
          AND l.due_timestamp > NOW()
          AND l.due_timestamp <= NOW() + (
                CASE WHEN u.telegram_id::bigint < 0
                     THEN INTERVAL '${BACKSTOP_UNREACHABLE_HOURS} hours'
                     ELSE INTERVAL '${BACKSTOP_HOURS} hours'
                END)`,
    );

    for (const row of rows) {
      const hrs = (
        (new Date(row.due_timestamp).getTime() - Date.now()) / 3_600_000
      ).toFixed(1);
      const sol = (Number(row.original_loan_amount_lamports) / 1e9).toFixed(4);

      // Mark first. If the alert fails we would rather under-notify than loop
      // and alert on every tick for the rest of the window.
      await query(`UPDATE loans SET warn_escalated_at = NOW() WHERE id = $1`, [row.id]);

      await notifyAdmin(
        bot,
        "⚠️ *Borrower may forfeit without warning*\n\n" +
          `Loan \`#${row.loan_id}\` is due in *${hrs}h* and no expiry warning has been delivered.\n` +
          `Wallet: \`${fmtWallet(row.borrower_wallet)}\`\n` +
          `Owed: *${sol} SOL*\n\n` +
          (row.structurally_unreachable
            ? "This borrower opened the loan on the website and has **no Telegram account** — " +
              "there is no channel to warn them on, and there never was. The dashboard notice " +
              "is the only thing that will reach them, and only if they visit.\n\n"
            : row.warn_undeliverable_reason
              ? `Telegram rejected the DM: \`${row.warn_undeliverable_reason}\`\n\n`
              : "No delivery failure was recorded — the warning simply never went out.\n\n") +
          "They can still be reached another way before the deadline.",
        { parse_mode: "Markdown" },
      ).catch(() => {});
    }
  } catch (err) {
    console.error("[loan-watcher] backstop failed (warnings unaffected):", err.message);
  }
}

// Format a deep-link to the user's dashboard view of a specific loan.
// The dashboard route accepts ?loan=<chain_loan_id> and scrolls/focuses
// the matching card so the user lands directly on the action surface.
const DASHBOARD_LOAN_BASE = process.env.DASHBOARD_LOAN_BASE
  || "https://magpie.capital/dashboard?loan=";

function fmtWallet(addr) {
  if (!addr || addr.length < 12) return addr || "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

async function warn24h(bot) {
  const { rows } = await query(
    `SELECT l.id, l.loan_id, l.user_id, l.due_timestamp,
            l.original_loan_amount_lamports,
            l.borrower_wallet,
            u.telegram_id
     FROM loans l JOIN users u ON u.id = l.user_id
     WHERE l.status = 'active'
       AND l.warned_24h_at IS NULL
       AND (l.warn_undeliverable_at IS NULL
            OR l.warn_undeliverable_at < NOW() - INTERVAL '${UNDELIVERABLE_RETRY}')
       AND l.due_timestamp <= NOW() + INTERVAL '24 hours'
       AND l.due_timestamp > NOW()`,
  );

  for (const row of rows) {
    const prefs = await getPrefs(row.user_id);
    if (!prefs.notify_loan_warnings) {
      await query(`UPDATE loans SET warned_24h_at = NOW() WHERE id = $1`, [row.id]);
      continue;
    }

    const hours = Math.max(
      0,
      Math.round((new Date(row.due_timestamp).getTime() - Date.now()) / 3_600_000),
    );
    const solOwed = Number(row.original_loan_amount_lamports) / 1e9;
    const loanLink = `${DASHBOARD_LOAN_BASE}${row.loan_id}`;
    const walletShort = fmtWallet(row.borrower_wallet);
    const msg = [
      "⚠️ *Loan due soon*",
      "",
      `Loan [#${row.loan_id}](${loanLink}) is due in ~${hours}h.`,
      `Wallet: \`${walletShort}\``,
      `Repay *${solOwed.toFixed(4)} SOL* to reclaim your collateral.`,
      "",
      `Tap the loan number above to open it in the dashboard, or use the buttons below.`,
    ].join("\n");
    const kb = new InlineKeyboard()
      .text("🔧 Repay now", `repay:loan:${row.id}`)
      .text("⏱ Extend", `extend:loan:${row.id}`)
      .row()
      .url("📋 Open loan in dashboard", loanLink);

    await deliverWarning(bot, row, "warned_24h_at", msg, kb);
  }
}

async function warn6h(bot) {
  const { rows } = await query(
    `SELECT l.id, l.loan_id, l.user_id, l.due_timestamp,
            l.original_loan_amount_lamports,
            l.borrower_wallet,
            u.telegram_id
     FROM loans l JOIN users u ON u.id = l.user_id
     WHERE l.status = 'active'
       AND l.warned_6h_at IS NULL
       AND (l.warn_undeliverable_at IS NULL
            OR l.warn_undeliverable_at < NOW() - INTERVAL '${UNDELIVERABLE_RETRY}')
       AND l.due_timestamp <= NOW() + INTERVAL '6 hours'
       AND l.due_timestamp > NOW()`,
  );

  for (const row of rows) {
    const prefs = await getPrefs(row.user_id);
    if (!prefs.notify_loan_warnings) {
      await query(`UPDATE loans SET warned_6h_at = NOW() WHERE id = $1`, [row.id]);
      continue;
    }

    const mins = Math.max(
      0,
      Math.round((new Date(row.due_timestamp).getTime() - Date.now()) / 60_000),
    );
    const solOwed = Number(row.original_loan_amount_lamports) / 1e9;
    const timeStr = mins >= 60 ? `${Math.round(mins / 60)}h ${mins % 60}m` : `${mins}m`;
    const loanLink = `${DASHBOARD_LOAN_BASE}${row.loan_id}`;
    const walletShort = fmtWallet(row.borrower_wallet);
    const msg = [
      "🚨 *URGENT — Loan expiring soon*",
      "",
      `Loan [#${row.loan_id}](${loanLink}) is due in *${timeStr}*.`,
      `Wallet: \`${walletShort}\``,
      `Repay *${solOwed.toFixed(4)} SOL* NOW to save your collateral.`,
      "",
      "After the deadline your tokens will be liquidated. Tap the loan number above or use a button below.",
    ].join("\n");
    const kb = new InlineKeyboard()
      .text("🔧 Repay now", `repay:loan:${row.id}`)
      .text("⏱ Extend", `extend:loan:${row.id}`)
      .row()
      .url("📋 Open loan in dashboard", loanLink);

    await deliverWarning(bot, row, "warned_6h_at", msg, kb);
  }
}

async function tick(bot) {
  await warn24h(bot);
  await warn6h(bot);
  // Runs last, so it judges the state the two passes above just produced.
  await checkUnwarnedNearDue(bot);
}

export function startLoanWatcher(bot) {
  console.log(`⏰ Loan watcher running (every ${POLL_INTERVAL_MS / 1000}s)`);
  const run = () => tick(bot).catch((err) => console.error("[loan-watcher]", err));
  run();
  return setInterval(run, POLL_INTERVAL_MS);
}
