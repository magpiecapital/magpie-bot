/**
 * TG commands for the user-driven governance nomination flow.
 */

import {
  createNomination,
  listNominations,
  getNomination,
  toggleUpvote,
  withdrawNomination,
  reviewNomination,
} from "../governance/nominations.js";
import { upsertUser } from "../services/users.js";
import { ensureWallet } from "../services/wallet.js";

const OPERATOR_IDS = (process.env.OPERATOR_TG_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isOperator(ctx) {
  if (OPERATOR_IDS.length === 0) return false;
  return OPERATOR_IDS.includes(String(ctx.from?.id ?? ""));
}

async function tryGetWallet(userId) {
  try {
    const w = await ensureWallet(userId);
    return w?.publicKey ?? null;
  } catch {
    return null;
  }
}

/**
 * /nominate <text>
 * Anyone can submit. Min 20 chars, max 1000, max 3/day per user.
 */
export async function handleNominate(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const rawText = (ctx.message?.text ?? "").replace(/^\/nominate(@\S+)?\s*/, "").trim();
  if (!rawText) {
    return ctx.reply(
      "Use: /nominate <your idea>\n\n" +
        "Example: /nominate Lower the minimum loan duration to 1 day so borrowers can use Magpie for very short-term cash needs.\n\n" +
        "Min 20 characters. Max 1000. Max 3 nominations per day.",
    );
  }

  const user = await upsertUser(tgUser.id, tgUser.username);
  const wallet = await tryGetWallet(user.id);

  try {
    const id = await createNomination({
      nominationText: rawText,
      nominatorTgId: tgUser.id,
      nominatorUsername: tgUser.username,
      nominatorWallet: wallet,
    });
    return ctx.reply(
      `Nomination #${id} submitted.\n\n` +
        `Others can upvote with /upvote_nomination ${id}\n` +
        `You can withdraw with /withdraw_nomination ${id}\n\n` +
        `If it gets enough community interest, the operator will review it for promotion to a formal MGP proposal.`,
    );
  } catch (err) {
    return ctx.reply(`Couldn't submit your nomination — ${err.message}`);
  }
}

/**
 * /nominations — list pending + queued, sorted by upvotes
 */
export async function handleNominationsList(ctx) {
  const noms = await listNominations({ status: ["pending", "queued"], limit: 10 });
  if (noms.length === 0) {
    return ctx.reply(
      "No active nominations right now.\n\n" +
        "Submit your own with /nominate <idea>",
    );
  }
  const lines = ["*Community Nominations* (top 10 by upvotes)", ""];
  for (const n of noms) {
    const headline = n.nomination_text.length > 100
      ? n.nomination_text.slice(0, 100) + "…"
      : n.nomination_text;
    lines.push(`*#${n.id}* — ${n.upvote_count} upvotes — by @${n.nominator_username || "anon"}`);
    lines.push(headline);
    lines.push(`  /upvote_nomination ${n.id}`);
    lines.push("");
  }
  lines.push("Submit your own: /nominate <idea>");
  return ctx.reply(lines.join("\n"), { parse_mode: "Markdown", disable_web_page_preview: true });
}

/**
 * /upvote_nomination <id>
 * Toggles — upvote if not yet, remove if already.
 */
export async function handleUpvoteNomination(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const parts = (ctx.message?.text ?? "").split(/\s+/);
  const id = Number(parts[1]);
  if (!Number.isInteger(id) || id <= 0) {
    return ctx.reply("Use: /upvote_nomination <id>\nExample: /upvote_nomination 7");
  }
  const nom = await getNomination(id);
  if (!nom) return ctx.reply(`Nomination #${id} not found.`);
  if (!["pending", "queued"].includes(nom.status)) {
    return ctx.reply(`Nomination #${id} is ${nom.status} — no longer accepting upvotes.`);
  }

  const user = await upsertUser(tgUser.id, tgUser.username);
  const wallet = await tryGetWallet(user.id);

  const r = await toggleUpvote({
    nominationId: id,
    upvoterTgId: tgUser.id,
    upvoterWallet: wallet,
  });
  return ctx.reply(
    r.now_upvoted
      ? `Upvoted nomination #${id} — now at ${r.count} upvotes.`
      : `Upvote removed from #${id} — now at ${r.count} upvotes.`,
  );
}

/**
 * /withdraw_nomination <id>
 * Only the original nominator can withdraw.
 */
export async function handleWithdrawNomination(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const parts = (ctx.message?.text ?? "").split(/\s+/);
  const id = Number(parts[1]);
  if (!Number.isInteger(id) || id <= 0) {
    return ctx.reply("Use: /withdraw_nomination <id>");
  }
  try {
    await withdrawNomination({ nominationId: id, nominatorTgId: tgUser.id });
    return ctx.reply(`Nomination #${id} withdrawn.`);
  } catch (err) {
    return ctx.reply(`Couldn't withdraw — ${err.message}`);
  }
}

/**
 * /nomination_review <id> <action> [reason]
 * Operator-only. Actions: queue, promote, reject, duplicate.
 *   /nomination_review 7 promote MGP-005
 *   /nomination_review 12 reject Out of scope for v0 governance
 *   /nomination_review 4 duplicate 2
 *   /nomination_review 9 queue Defer for community input
 */
export async function handleNominationReview(ctx) {
  if (!isOperator(ctx)) return ctx.reply("Command is operator-only.");
  const text = (ctx.message?.text ?? "").replace(/^\/nomination_review(@\S+)?\s*/, "").trim();
  const parts = text.split(/\s+/);
  const id = Number(parts[0]);
  const action = parts[1];
  const tail = parts.slice(2).join(" ");

  if (!Number.isInteger(id) || id <= 0 || !["queue", "promote", "reject", "duplicate"].includes(action)) {
    return ctx.reply(
      "Use: /nomination_review <id> <action> [reason|proposal_id|duplicate_id]\n" +
        "Actions: queue · promote · reject · duplicate",
    );
  }

  try {
    await reviewNomination({
      nominationId: id,
      operatorTgId: ctx.from.id,
      action,
      reason: action === "reject" || action === "queue" ? tail : null,
      promotedToProposalId: action === "promote" ? tail : null,
      duplicateOfId: action === "duplicate" ? Number(tail) || null : null,
    });
    return ctx.reply(`Nomination #${id} marked as ${action}.`);
  } catch (err) {
    return ctx.reply(`Couldn't review — ${err.message}`);
  }
}

/**
 * /my_nominations — show nominations the caller has submitted
 */
export async function handleMyNominations(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const { query } = await import("../db/pool.js");
  const { rows } = await query(
    `SELECT id, nomination_text, status, upvote_count, created_at
       FROM governance_nominations
       WHERE nominator_tg_id = $1
       ORDER BY created_at DESC LIMIT 20`,
    [String(tgUser.id)],
  );
  if (rows.length === 0) {
    return ctx.reply("You haven't submitted any nominations yet. Try /nominate <your idea>.");
  }
  const lines = ["*Your Nominations*", ""];
  for (const r of rows) {
    const head = r.nomination_text.length > 80 ? r.nomination_text.slice(0, 80) + "…" : r.nomination_text;
    lines.push(`#${r.id} · ${r.status} · ${r.upvote_count} upvotes`);
    lines.push(head);
    lines.push("");
  }
  return ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
