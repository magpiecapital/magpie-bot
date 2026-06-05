/**
 * /security — single-screen security view for the user.
 *
 * Consolidates the user's security state:
 *   • Site-lock status (locked/until or open)
 *   • Recent site-initiated signed actions (last 24h, by purpose)
 *   • Recent site withdraws (last 5)
 *   • Linked wallets count
 *   • Auto-Protect on/off
 *
 * Designed to be the first thing a user runs if they suspect something
 * is off. Companion to /privacy (data) and /lock (kill-switch).
 */
import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { getSiteLock } from "../services/site-lock.js";
import { getPrefs } from "../services/prefs.js";
import { query } from "../db/pool.js";

function fmtSol(lamports) {
  if (lamports == null) return "0";
  return (Number(lamports) / 1e9).toFixed(4);
}

function shortAddr(addr) {
  if (!addr) return "?";
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function ageStr(date) {
  if (!date) return "";
  const mins = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / (60 * 24))}d ago`;
}

export async function handleSecurity(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const user = await upsertUser(tgUser.id, tgUser.username);

  const [lock, prefs, walletsRes, withdrawsRes, noncesRes] = await Promise.all([
    getSiteLock(user.id),
    getPrefs(user.id),
    query(
      `SELECT COUNT(*)::int AS n FROM wallets WHERE user_id = $1`,
      [user.id],
    ),
    query(
      `SELECT asset, raw_amount::text AS raw_amount, decimals,
              to_pubkey, status, tx_signature, created_at
         FROM site_withdrawals
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 5`,
      [user.id],
    ),
    query(
      `SELECT n.purpose, COUNT(*)::int AS n
         FROM used_nonces n
         JOIN wallets w ON w.public_key = n.signer_pubkey
        WHERE w.user_id = $1
          AND n.created_at > NOW() - INTERVAL '24 hours'
        GROUP BY n.purpose
        ORDER BY n DESC`,
      [user.id],
    ),
  ]);

  const lines = [
    "🔐 *Your security view*",
    "",
  ];

  if (lock.locked && lock.until) {
    const until = lock.until.toISOString().slice(0, 16).replace("T", " ");
    lines.push(
      `🔒 *Site signed actions LOCKED* until ${until} UTC`,
      "Run /lock 0 here to clear once you've rotated keys.",
      "",
    );
  } else {
    lines.push(
      `🔓 Site signed actions open. Run /lock 24 if you suspect compromise.`,
      "",
    );
  }

  lines.push(
    `🛡 Auto-Protect: ${prefs.auto_protect ? "*on*" : "off"}`,
    `📚 Linked wallets: ${walletsRes.rows[0].n}`,
    "",
  );

  lines.push("*Site signed actions (24h):*");
  if (noncesRes.rows.length === 0) {
    lines.push("  none");
  } else {
    for (const r of noncesRes.rows) {
      lines.push(`  • ${r.purpose}: ${r.n}`);
    }
  }
  lines.push("");

  lines.push("*Recent site withdraws:*");
  if (withdrawsRes.rows.length === 0) {
    lines.push("  none");
  } else {
    for (const w of withdrawsRes.rows) {
      const amt = w.asset === "SOL"
        ? `${fmtSol(w.raw_amount)} SOL`
        : `${(Number(w.raw_amount) / 10 ** (w.decimals || 0)).toFixed(2)} ${shortAddr(w.asset)}`;
      const status = w.status === "confirmed" ? "✓" : w.status === "failed" ? "✗" : "…";
      lines.push(`  ${status} ${amt} → ${shortAddr(w.to_pubkey)} · ${ageStr(w.created_at)}`);
    }
  }

  lines.push(
    "",
    "_Anything you don't recognize? Run /lock 24 right now and reach out via /support._",
  );

  const kb = new InlineKeyboard()
    .text("🔒 Lock 24h", "sec:lock:24")
    .text("🔒 Lock 7d", "sec:lock:168");

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: kb,
    disable_web_page_preview: true,
  });
}
