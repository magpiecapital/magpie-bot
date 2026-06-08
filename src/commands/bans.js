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
import { traceAndBanFunders } from "../services/funding-graph.js";
import { invalidateExemptCache } from "../services/anti-exploit.js";

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

export async function handleExploitReport(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const [autoBans, manualBans, funderTraces, suspendedLoans] = await Promise.all([
    query(
      `SELECT bu.user_id, bu.telegram_id, bu.reason, bu.banned_at, u.telegram_username
         FROM banned_users bu
         LEFT JOIN users u ON u.id = bu.user_id
        WHERE bu.banned_by = 'exploit-detector'
          AND bu.banned_at > NOW() - INTERVAL '24 hours'
        ORDER BY bu.banned_at DESC LIMIT 20`,
    ),
    query(
      `SELECT COUNT(*)::int AS n FROM banned_users
        WHERE banned_at > NOW() - INTERVAL '24 hours'
          AND banned_by NOT LIKE 'exploit-%' AND banned_by NOT LIKE 'funding-%'`,
    ),
    query(
      `SELECT action, COUNT(*)::int AS n
         FROM funding_traces
        WHERE traced_at > NOW() - INTERVAL '24 hours'
        GROUP BY action`,
    ),
    query(
      `SELECT l.loan_id, l.user_id, l.suspended_reason, l.suspended_at,
              u.telegram_username
         FROM loans l
         LEFT JOIN users u ON u.id = l.user_id
        WHERE l.suspended = TRUE
          AND l.suspended_at > NOW() - INTERVAL '24 hours'
        ORDER BY l.suspended_at DESC LIMIT 10`,
    ),
  ]);

  const lines = ["🛡 *Exploit-detector report — last 24h*", ""];
  lines.push(`Auto-bans: *${autoBans.rows.length}*`);
  lines.push(`Manual bans: *${manualBans.rows[0]?.n ?? 0}*`);
  lines.push(`Suspended loans: *${suspendedLoans.rows.length}*`);
  const traceTotals = Object.fromEntries(funderTraces.rows.map((r) => [r.action, r.n]));
  lines.push(
    `Funder traces: banned=${traceTotals.banned ?? 0}, skipped_cex=${traceTotals.skipped_cex ?? 0}, ` +
      `skipped_already_banned=${traceTotals.skipped_already_banned ?? 0}`,
  );
  lines.push("");

  if (autoBans.rows.length) {
    lines.push("*Recent auto-bans:*");
    for (const r of autoBans.rows) {
      const t = new Date(r.banned_at).toISOString().slice(11, 16);
      lines.push(`  • [${t}] #${r.user_id} @${r.telegram_username ?? "?"} — ${(r.reason ?? "").slice(0, 60)}`);
    }
    lines.push("");
  }

  if (suspendedLoans.rows.length) {
    lines.push("*Suspended loans:*");
    for (const r of suspendedLoans.rows) {
      lines.push(`  • Loan #${r.loan_id} (u${r.user_id}) — ${(r.suspended_reason ?? "").slice(0, 50)}`);
    }
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

/* ────────────────────── TOKEN CAP COMMANDS ────────────────────── */

export async function handleSetTokenCap(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const args = parseArgs(ctx);
  if (!args[0] || !args[1]) {
    return ctx.reply(
      "Usage: `/set_token_cap <mint> <sol_amount|unlimited|default>`\n\n" +
        "• `<sol_amount>` — cap in SOL (e.g. 100)\n" +
        "• `unlimited` — no cap (recommended for $MAGPIE)\n" +
        "• `default` — fall back to protocol default (10 SOL)",
      { parse_mode: "Markdown" },
    );
  }
  const mint = args[0];
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return ctx.reply("That doesn't look like a valid Solana mint.");
  }
  const arg = args[1].toLowerCase();
  let maxLamports;
  let display;
  if (arg === "unlimited") {
    maxLamports = 0n;
    display = "unlimited (no cap)";
  } else if (arg === "default") {
    maxLamports = null;
    display = "default (protocol-wide cap applies)";
  } else {
    const sol = Number(arg);
    if (!Number.isFinite(sol) || sol < 0) {
      return ctx.reply("SOL amount must be a non-negative number, or `unlimited`/`default`.");
    }
    maxLamports = BigInt(Math.floor(sol * 1e9));
    display = `${sol} SOL`;
  }

  const { rowCount } = await query(
    `UPDATE supported_mints SET max_open_lamports = $2 WHERE mint = $1`,
    [mint, maxLamports === null ? null : maxLamports.toString()],
  );
  if (!rowCount) {
    return ctx.reply(`No supported_mints row for \`${mint}\` — enable it first via /enablemint.`, { parse_mode: "Markdown" });
  }
  await ctx.reply(
    `✅ Token cap set: \`${mint}\` → ${display}`,
    { parse_mode: "Markdown" },
  );
}

export async function handleTokenCapList(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const { rows } = await query(
    `SELECT mint, symbol, max_open_lamports
       FROM supported_mints
      WHERE enabled = TRUE
        AND max_open_lamports IS NOT NULL
      ORDER BY max_open_lamports::numeric DESC NULLS LAST`,
  );
  const lines = ["🏷 *Per-token cap overrides*", ""];
  if (!rows.length) {
    lines.push("(none — all tokens use protocol default)");
  } else {
    for (const r of rows) {
      const val = r.max_open_lamports;
      const display = String(val) === "0" ? "unlimited" : `${(Number(val) / 1e9).toFixed(2)} SOL`;
      lines.push(`  • *${r.symbol}* → ${display}  \`${r.mint}\``);
    }
  }
  lines.push("", "_Default for everything else: 10 SOL (env BORROW_PER_TOKEN_OPEN_CAP_SOL)_");
  lines.push("Set via `/set_token_cap <mint> <sol|unlimited|default>`");
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

/* ────────────────────── EXEMPT WALLET COMMANDS ────────────────────── */

export async function handleExemptAdd(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const args = parseArgs(ctx);
  if (!args[0]) {
    return ctx.reply("Usage: `/exempt_add <pubkey> [reason words...]`", { parse_mode: "Markdown" });
  }
  const pubkey = args[0];
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pubkey)) {
    return ctx.reply("That doesn't look like a valid Solana pubkey.");
  }
  const reason = args.slice(1).join(" ") || null;
  await query(
    `INSERT INTO borrow_exempt_wallets (wallet_pubkey, added_by, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (wallet_pubkey) DO UPDATE
       SET added_by = EXCLUDED.added_by,
           reason = COALESCE(EXCLUDED.reason, borrow_exempt_wallets.reason),
           added_at = NOW()`,
    [pubkey, String(ctx.from?.id ?? "operator"), reason],
  );
  invalidateExemptCache();
  await ctx.reply(
    `✅ Wallet \`${pubkey}\` added to borrow-exempt list.\n\n` +
      `Bypasses: imported-wallet cooldown + new-account cap.\n` +
      `Still subject to: bans, per-token cap, pool floor, TWAP, rapid-fire.\n` +
      `Reason: ${reason ?? "(none)"}`,
    { parse_mode: "Markdown" },
  );
}

export async function handleExemptRemove(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const args = parseArgs(ctx);
  if (!args[0]) {
    return ctx.reply("Usage: `/exempt_remove <pubkey>`", { parse_mode: "Markdown" });
  }
  const pubkey = args[0];
  const { rowCount } = await query(
    `DELETE FROM borrow_exempt_wallets WHERE wallet_pubkey = $1`,
    [pubkey],
  );
  invalidateExemptCache();
  await ctx.reply(
    rowCount
      ? `✅ Removed \`${pubkey}\` from borrow-exempt list.`
      : `⚠️ Wallet \`${pubkey}\` was not on the exempt list.`,
    { parse_mode: "Markdown" },
  );
}

export async function handleExemptList(ctx) {
  if (!(await requireAdmin(ctx))) return;
  const { rows } = await query(
    `SELECT wallet_pubkey, added_by, reason, added_at
       FROM borrow_exempt_wallets
      ORDER BY added_at DESC`,
  );
  const envList = (process.env.BORROW_EXEMPT_WALLETS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const lines = ["🪶 *Borrow-exempt wallets*", ""];
  if (envList.length) {
    lines.push("*Env-configured (BORROW_EXEMPT_WALLETS):*");
    for (const w of envList) lines.push(`  • \`${w}\``);
    lines.push("");
  }
  lines.push(`*DB-managed (${rows.length}):*`);
  if (!rows.length) {
    lines.push("  (none)");
  } else {
    for (const r of rows) {
      lines.push(
        `  • \`${r.wallet_pubkey}\` — ${r.reason ?? "(no reason)"} _(by ${r.added_by})_`,
      );
    }
  }
  lines.push("", "Manage with `/exempt_add` and `/exempt_remove`.");
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
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

  // Trace funders for each wallet — extends the sweep to the funding
  // graph so the operator gets the wallet-swap defense automatically.
  let totalFundersBanned = 0;
  for (const w of walletRows) {
    try {
      const r = await traceAndBanFunders(w.public_key, reason, userId);
      totalFundersBanned += r.banned?.length || 0;
    } catch (err) {
      console.warn(`[ban_sweep] funder trace failed for ${w.public_key}: ${err.message}`);
    }
  }

  const lines = [
    `🚫🚫 *Ban sweep applied*`,
    ``,
    `User: #${userId} @${u.telegram_username ?? "?"} (tg ${u.telegram_id})`,
    `Reason: ${reason}`,
    `Wallets banned: ${walletRows.length}`,
    `Funder wallets banned: ${totalFundersBanned}`,
    ...walletRows.map((w) => `  • \`${w.public_key}\``),
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
