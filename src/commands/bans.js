/**
 * Operator-only commands for the user/wallet ban registry.
 *
 *   /ban_user <user_id> [reason]      — ban by Magpie user_id
 *   /ban_tg <telegram_id> [reason]    — ban by telegram_id (looks up user_id)
 *   /ban_wallet <pubkey> [reason]     — ban a single wallet pubkey
 *   /unban_user <user_id>
 *   /unban_wallet <pubkey>
 *   /ban_list                         — show current bans (most recent first)
 *   /ban_sweep <user_id>              — ban the user AND every wallet
 *                                       associated with them (the nuclear
 *                                       option — exactly what we want for
 *                                       a confirmed exploit attacker)
 *
 * All operator-gated via isAdmin.
 */
import { isAdmin } from "../services/admin.js";
import { query } from "../db/pool.js";
import {
  banUser as _banUser,
  unbanUser as _unbanUser,
  banWallet as _banWallet,
  unbanWallet as _unbanWallet,
} from "../services/bans.js";

async function requireAdmin(ctx) {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply("❌ Not authorized.");
    return false;
  }
  return true;
}

function parseArgs(ctx) {
  const text = ctx.message?.text || "";
  const idx = text.indexOf(" ");
  if (idx === -1) return [];
  return text.slice(idx + 1).trim().split(/\s+/);
}

export async function handleBanUser(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const args = parseArgs(ctx);
  if (!args[0]) {
    return ctx.reply("Usage: `/ban_user <user_id> [reason words...]`", { parse_mode: "Markdown" });
  }
  const userId = Number(args[0]);
  if (!Number.isInteger(userId)) return ctx.reply("user_id must be an integer");
  const reason = args.slice(1).join(" ") || null;
  const { rows } = await query(
    `SELECT id, telegram_id, telegram_username FROM users WHERE id = $1`,
    [userId],
  );
  if (!rows.length) return ctx.reply(`No user with id ${userId}`);
  const u = rows[0];
  await _banUser({
    userId,
    telegramId: u.telegram_id,
    reason,
    bannedBy: String(ctx.from?.id ?? "operator"),
  });
  await ctx.reply(
    `🚫 Banned user ${userId} (@${u.telegram_username ?? "?"}, tg ${u.telegram_id})\nReason: ${reason ?? "(none)"}`,
  );
}

export async function handleBanTg(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const args = parseArgs(ctx);
  if (!args[0]) {
    return ctx.reply("Usage: `/ban_tg <telegram_id> [reason words...]`", { parse_mode: "Markdown" });
  }
  const telegramId = Number(args[0]);
  if (!Number.isInteger(telegramId)) return ctx.reply("telegram_id must be an integer");
  const reason = args.slice(1).join(" ") || null;
  const { rows } = await query(
    `SELECT id, telegram_username FROM users WHERE telegram_id = $1`,
    [telegramId],
  );
  if (!rows.length) {
    // banned_users.user_id is the PK and can't be null, so we can't
    // store a ban for a telegram_id that has no Magpie account yet.
    // In practice every attacker has already /started the bot before
    // we want to ban them (they had to to import a wallet), so this
    // path is mostly a usage hint.
    return ctx.reply(
      `⚠️ No Magpie user has telegram_id ${telegramId}. They need to /start the bot first.\n` +
      `If they never interact, they can't borrow anyway. If they do, run this command again.`,
    );
  }
  const u = rows[0];
  await _banUser({
    userId: u.id,
    telegramId,
    reason,
    bannedBy: String(ctx.from?.id ?? "operator"),
  });
  await ctx.reply(
    `🚫 Banned tg ${telegramId} → user ${u.id} (@${u.telegram_username ?? "?"})\nReason: ${reason ?? "(none)"}`,
  );
}

export async function handleBanWallet(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const args = parseArgs(ctx);
  if (!args[0]) {
    return ctx.reply("Usage: `/ban_wallet <pubkey> [reason words...]`", { parse_mode: "Markdown" });
  }
  const pubkey = args[0];
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pubkey)) {
    return ctx.reply("That doesn't look like a valid Solana pubkey.");
  }
  const reason = args.slice(1).join(" ") || null;
  // Try to associate with an owning user_id for nicer audit trail.
  const { rows } = await query(
    `SELECT user_id FROM wallets WHERE public_key = $1 LIMIT 1`,
    [pubkey],
  );
  const relatedUserId = rows[0]?.user_id ?? null;
  await _banWallet({
    pubkey,
    reason,
    bannedBy: String(ctx.from?.id ?? "operator"),
    relatedUserId,
  });
  await ctx.reply(`🚫 Banned wallet \`${pubkey}\`${relatedUserId ? ` (user ${relatedUserId})` : ""}\nReason: ${reason ?? "(none)"}`, { parse_mode: "Markdown" });
}

export async function handleUnbanUser(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const args = parseArgs(ctx);
  if (!args[0]) return ctx.reply("Usage: `/unban_user <user_id>`", { parse_mode: "Markdown" });
  const userId = Number(args[0]);
  if (!Number.isInteger(userId)) return ctx.reply("user_id must be an integer");
  const n = await _unbanUser(userId);
  await ctx.reply(n ? `✅ Unbanned user ${userId}` : `⚠️ User ${userId} was not banned`);
}

export async function handleUnbanWallet(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const args = parseArgs(ctx);
  if (!args[0]) return ctx.reply("Usage: `/unban_wallet <pubkey>`", { parse_mode: "Markdown" });
  const pubkey = args[0];
  const n = await _unbanWallet(pubkey);
  await ctx.reply(n ? `✅ Unbanned wallet \`${pubkey}\`` : `⚠️ Wallet \`${pubkey}\` was not banned`, { parse_mode: "Markdown" });
}

export async function handleBanList(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const [users, wallets] = await Promise.all([
    query(
      `SELECT bu.user_id, bu.telegram_id, bu.reason, bu.banned_at, u.telegram_username
         FROM banned_users bu
         LEFT JOIN users u ON u.id = bu.user_id
        ORDER BY bu.banned_at DESC
        LIMIT 25`,
    ),
    query(
      `SELECT wallet_pubkey, related_user_id, reason, banned_at
         FROM banned_wallets
        ORDER BY banned_at DESC
        LIMIT 25`,
    ),
  ]);

  const lines = ["🚫 *Ban list* (most recent 25 each)", ""];
  lines.push("*Users:*");
  if (!users.rows.length) lines.push("  (none)");
  else {
    for (const r of users.rows) {
      lines.push(
        `  • #${r.user_id ?? "?"} @${r.telegram_username ?? "?"} (tg ${r.telegram_id ?? "?"}) — ${r.reason ?? "(no reason)"}`,
      );
    }
  }
  lines.push("");
  lines.push("*Wallets:*");
  if (!wallets.rows.length) lines.push("  (none)");
  else {
    for (const r of wallets.rows) {
      const short = `${r.wallet_pubkey.slice(0, 6)}…${r.wallet_pubkey.slice(-4)}`;
      lines.push(`  • \`${short}\`${r.related_user_id ? ` (u${r.related_user_id})` : ""} — ${r.reason ?? "(no reason)"}`);
    }
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

/**
 * The "nuclear option" — what we run for a confirmed exploit attacker.
 *
 *   - Bans the user_id
 *   - Bans EVERY wallet ever associated with that user_id
 *
 * If the attacker creates a fresh telegram_id and imports any of their
 * old wallets, the wallet-level ban catches it. If they instead create
 * a new wallet inside the new TG account, the operator can come back
 * here and run /ban_sweep again on the new user_id.
 */
export async function handleBanSweep(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const args = parseArgs(ctx);
  if (!args[0]) {
    return ctx.reply("Usage: `/ban_sweep <user_id> [reason words...]`", { parse_mode: "Markdown" });
  }
  const userId = Number(args[0]);
  if (!Number.isInteger(userId)) return ctx.reply("user_id must be an integer");
  const reason = args.slice(1).join(" ") || "operator-initiated ban_sweep";

  const { rows: userRow } = await query(
    `SELECT id, telegram_id, telegram_username FROM users WHERE id = $1`,
    [userId],
  );
  if (!userRow.length) return ctx.reply(`No user with id ${userId}`);
  const u = userRow[0];

  const { rows: walletRows } = await query(
    `SELECT public_key FROM wallets WHERE user_id = $1`,
    [userId],
  );

  await _banUser({
    userId,
    telegramId: u.telegram_id,
    reason,
    bannedBy: String(ctx.from?.id ?? "operator"),
    notes: `ban_sweep — ${walletRows.length} wallet(s) also banned`,
  });

  for (const w of walletRows) {
    await _banWallet({
      pubkey: w.public_key,
      reason,
      bannedBy: String(ctx.from?.id ?? "operator"),
      relatedUserId: userId,
      notes: `ban_sweep linked to user ${userId}`,
    });
  }

  const lines = [
    `🚫🚫 *Ban sweep applied*`,
    ``,
    `User: #${userId} @${u.telegram_username ?? "?"} (tg ${u.telegram_id})`,
    `Reason: ${reason}`,
    `Wallets banned: ${walletRows.length}`,
    ...walletRows.map((w) => `  • \`${w.public_key}\``),
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
