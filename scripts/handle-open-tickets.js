#!/usr/bin/env node
/**
 * One-shot ticket handler for the current backlog.
 *
 * For each ticket below, either:
 *   - DM the user via the TG bot + mark awaiting_user (admin_reply set)
 *   - Force-close (no DM) — used for AI-generated duplicates already
 *     superseded by a personal admin reply
 *
 * Does NOT touch tickets flagged as financial-impact (B_T_F_D LP,
 * Vanbronckhorst /topup) — those wait for the operator to decide
 * reimbursement.
 *
 * Run: node scripts/handle-open-tickets.js
 */
import "dotenv/config";
import { query } from "../src/db/pool.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set in .env");
  process.exit(1);
}

async function tgSendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "💬 Follow up", callback_data: `myt:followup:0` },
          { text: "✅ Resolved",  callback_data: `myt:close:0` },
        ]],
      },
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(`TG ${res.status}: ${body.description || JSON.stringify(body)}`);
  return body;
}

async function replyAndAwaitUser(ticketId, message) {
  const { rows: [t] } = await query(
    `SELECT s.id, u.telegram_id FROM support_tickets s
       JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [ticketId],
  );
  if (!t) return { ticketId, action: "skip", reason: "ticket not found" };

  const body = [
    `📩 *Magpie support · Ticket #${ticketId}*`,
    "",
    message,
    "",
    "_Reply via the buttons below — or run /mytickets any time._",
  ].join("\n");

  // Send via direct fetch so we can swap in the per-ticket callback_data
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: Number(t.telegram_id),
      text: body,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "💬 Follow up", callback_data: `myt:followup:${ticketId}` },
          { text: "✅ Resolved",  callback_data: `myt:close:${ticketId}` },
        ]],
      },
    }),
  });
  const tgBody = await res.json();
  if (!res.ok || !tgBody.ok) {
    return { ticketId, action: "fail", reason: `TG ${res.status}: ${tgBody.description}` };
  }

  await query(
    `UPDATE support_tickets
        SET status='awaiting_user',
            admin_reply=$2,
            admin_replied_at=NOW(),
            last_alerted_tier=NULL
      WHERE id=$1`,
    [ticketId, message],
  );
  return { ticketId, action: "replied" };
}

async function forceClose(ticketId, note) {
  const r = await query(
    `UPDATE support_tickets
        SET status='closed',
            closed_at=NOW(),
            admin_reply=COALESCE(admin_reply, '') || '\n\n[closed by operator] ' || $2,
            last_alerted_tier=NULL
      WHERE id=$1 RETURNING id`,
    [ticketId, note],
  );
  return { ticketId, action: r.rowCount > 0 ? "closed" : "not-found" };
}

const ACTIONS = [
  // ── Wowloco saga — auto-resolver explained the wallet situation in
  //    #16 and #18; loan ID #15 references doesn't exist in DB anyway.
  //    Send a friendly check-in to #15 then close.
  {
    kind: "reply",
    ticket: 15,
    message:
      "Hey — circling back on this. Looking at your account, the loan you were worried about is on the *same wallet you're using right now* (`9zaooD3LvoF…6pNv`) — so there was never a key-recovery situation to solve. Your active loan history checks out and everything's repaid on time.\n\n" +
      "If something still doesn't feel right or you can't see a loan you expected to see, just message back and I'll dig in. Otherwise I'll consider this resolved.",
  },

  // ── Deezwear bug-report root: you personally replied on #37 yesterday
  //    confirming the 13,805 MAGPIE was returned. Acknowledge + close.
  {
    kind: "reply",
    ticket: 19,
    message:
      "Quick wrap-up on this — the team verified on-chain yesterday and confirmed your *13,805 MAGPIE collateral was actually returned to your wallet on June 4*, right after the repay. The escrow PDA closed correctly; the alarming numbers in the DB (negative percent paid off, owed > principal) were a display artifact, not a real anomaly.\n\n" +
      "Sorry for the back-and-forth on this one — the auto-resolver kept opening duplicate tickets while it tried to dig in. We've cleaned them up. If your wallet still doesn't show the MAGPIE balance you expect, message back and we'll re-check, but the on-chain reality is good.",
  },

  // ── Deezwear duplicate chain (AI-generated tickets #20-#36, all
  //    same underlying issue, all awaiting_user). Force-close with a
  //    note — no DM, user already saw the substantive reply on #37.
  { kind: "close", ticket: 20, note: "dup of #19, resolved via #37" },
  { kind: "close", ticket: 21, note: "dup of #19, resolved via #37" },
  { kind: "close", ticket: 22, note: "dup of #19, resolved via #37" },
  { kind: "close", ticket: 23, note: "dup of #19, resolved via #37" },
  { kind: "close", ticket: 24, note: "dup of #19, resolved via #37" },
  { kind: "close", ticket: 25, note: "dup of #19, resolved via #37" },
  { kind: "close", ticket: 26, note: "dup of #19, resolved via #37" },
  { kind: "close", ticket: 27, note: "dup of #19, resolved via #37" },
  { kind: "close", ticket: 28, note: "dup of #19, resolved via #37" },
  { kind: "close", ticket: 29, note: "dup of #19, resolved via #37" },
  { kind: "close", ticket: 30, note: "dup of #19, resolved via #37" },
  { kind: "close", ticket: 31, note: "dup of #19, resolved via #37" },
  { kind: "close", ticket: 32, note: "dup of #19, resolved via #37" },
  { kind: "close", ticket: 33, note: "dup of #19, resolved via #37" },
  { kind: "close", ticket: 34, note: "dup of #19, resolved via #37" },
  { kind: "close", ticket: 36, note: "dup of #19, resolved via #37" },
  { kind: "close", ticket: 37, note: "resolved by personal admin reply 2026-06-05" },

  // ── zach_chills TROLL display bug — purely cosmetic.
  {
    kind: "reply",
    ticket: 35,
    message:
      "Thanks for catching this — confirming the TROLL token decimal-scale display bug. The on-chain amounts are correct, it's purely a UI display issue at our end. We've logged it for the dev queue and will push a fix.\n\n" +
      "*Your collateral is fine* — the actual locked amount on-chain is what was committed when you opened the loan, not the wonky number in the bot UI. If you want to verify, you can pull up your loan PDA on Solscan and compare.",
  },
];

async function main() {
  console.log("\nProcessing", ACTIONS.length, "actions…\n");
  for (const a of ACTIONS) {
    try {
      let r;
      if (a.kind === "reply") {
        r = await replyAndAwaitUser(a.ticket, a.message);
      } else if (a.kind === "close") {
        r = await forceClose(a.ticket, a.note);
      }
      console.log(`#${a.ticket} → ${r.action}` + (r.reason ? ` (${r.reason})` : ""));
      // Soft throttle so we don't pummel TG
      await new Promise((res) => setTimeout(res, 350));
    } catch (e) {
      console.log(`#${a.ticket} → ERROR: ${e.message}`);
    }
  }
  console.log("\nDone.\n");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
