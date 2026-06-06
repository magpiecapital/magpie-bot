#!/usr/bin/env node
/**
 * Send replies to the 4 tickets that were initially flagged for
 * operator review, after verification that nothing requires
 * reimbursement.
 */
import "dotenv/config";
import { query } from "../src/db/pool.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) { console.error("TELEGRAM_BOT_TOKEN not set"); process.exit(1); }

async function replyAndAwaitUser(ticketId, message) {
  const { rows: [t] } = await query(
    `SELECT s.id, u.telegram_id FROM support_tickets s
       JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [ticketId],
  );
  if (!t) return { ticketId, action: "skip", reason: "not found" };

  const body = [
    `📩 *Magpie support · Ticket #${ticketId}*`,
    "",
    message,
    "",
    "_Reply via the buttons below — or run /mytickets any time._",
  ].join("\n");

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
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
  const tg = await res.json();
  if (!res.ok || !tg.ok) {
    return { ticketId, action: "fail", reason: `TG ${res.status}: ${tg.description}` };
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
        SET status='closed', closed_at=NOW(),
            admin_reply=COALESCE(admin_reply,'') || '\n\n[closed by operator] ' || $2,
            last_alerted_tier=NULL
      WHERE id=$1 RETURNING id`,
    [ticketId, note],
  );
  return { ticketId, action: r.rowCount > 0 ? "closed" : "not-found" };
}

const ACTIONS = [
  // ── B_T_F_D (#38 + #40 same user) — no LP records in DB.
  //    Reply on #38 (older), close #40 as dup.
  {
    kind: "reply",
    ticket: 38,
    message:
      "Hey — dug into this. Our LP indexer shows *zero positions* across either of your wallets (your active one and `ENMZHE8sYY9zDmakdKJkVfMLESqpnFHkU86H4CXMKfhS`). No deposit txs recorded.\n\n" +
      "Most likely thing: the status you're seeing reflects *wallet connection*, not an actual LP deposit. To earn yield you need to deposit via `/earn` here in Telegram or at magpie.capital/earn — that opens an LP position which then starts accruing on the 80% loan-fee share + the 2% loyalty bonus.\n\n" +
      "If you DID deposit and have the tx signature, paste it here and I'll verify on-chain — possible our indexer missed it. Otherwise no funds are at risk, you just haven't opened a position yet.",
  },
  { kind: "close", ticket: 40, note: "dup of #38, same user same issue" },

  // ── Vanbronckhorst (#39 + #41 same user, EN + TR) — real bug, now
  //    fixed. Collateral landed on-chain even though DB write failed.
  //    Reply on #39, close #41.
  {
    kind: "reply",
    ticket: 39,
    message:
      "Wanted to circle back on the /topup error you hit. *Good news first:* your collateral was never actually lost.\n\n" +
      "We found the bug — a SQL type mismatch on our end was rejecting the database write *after* the on-chain transfer had already landed. So even though the bot threw an error, the additional tokens did get locked into your loan's collateral account on-chain. The protocol still saw them.\n\n" +
      "How we know your repays were correct: when you later repaid, the on-chain settlement releases the *actual locked* collateral, not whatever amount our DB happened to record. That's why it worked even with the data mismatch.\n\n" +
      "*The fix is deployed* (commit fdd6028 if you want to look) — future /topups will record cleanly. Same fix patched five other silent write bugs in the LP loyalty + $MAGPIE holder reward accrual paths, so it was a worthwhile dig.\n\n" +
      "Sorry for the scare the error message caused. If you want me to verify the math on any specific loan, paste the loan ID. Otherwise you're whole.",
  },
  { kind: "close", ticket: 41, note: "dup of #39 (TR version), same user same issue" },
];

async function main() {
  console.log("\nProcessing", ACTIONS.length, "actions…\n");
  for (const a of ACTIONS) {
    try {
      const r = a.kind === "reply"
        ? await replyAndAwaitUser(a.ticket, a.message)
        : await forceClose(a.ticket, a.note);
      console.log(`#${a.ticket} → ${r.action}` + (r.reason ? ` (${r.reason})` : ""));
      await new Promise((res) => setTimeout(res, 350));
    } catch (e) {
      console.log(`#${a.ticket} → ERROR: ${e.message}`);
    }
  }
  console.log("\nDone.\n");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
