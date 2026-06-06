/**
 * /signedhistory — list the user's last 10 site-signed actions.
 *
 * Different from /activity: this is the raw signed-action log straight
 * from used_nonces, broken down by purpose (withdraw / support_ask /
 * wallets_set_active / prefs_set / ai_chat / support_ticket_details /
 * support_delete_ticket / me_export). Useful for users who want a
 * complete forensic view of every signed click they've made.
 */
import { upsertUser } from "../services/users.js";
import { query } from "../db/pool.js";

function ageStr(date) {
  if (!date) return "";
  const mins = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / (60 * 24))}d ago`;
}

function shortAddr(addr) {
  if (!addr) return "?";
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export async function handleSignedHistory(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const user = await upsertUser(tgUser.id, tgUser.username);

  const { rows } = await query(
    `SELECT n.purpose, n.signer_pubkey, n.created_at
       FROM used_nonces n
       JOIN wallets w ON w.public_key = n.signer_pubkey
      WHERE w.user_id = $1
      ORDER BY n.created_at DESC
      LIMIT 10`,
    [user.id],
  );

  if (rows.length === 0) {
    return ctx.reply(
      [
        "📜 *Signed action history*",
        "",
        "No signed site actions yet. The dashboard at magpie.capital signs an Ed25519 message for every write — withdraws, support, wallets switch, prefs, AI chat.",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  }

  const lines = ["📜 *Last 10 signed site actions*", ""];
  for (const r of rows) {
    lines.push(
      `• ${ageStr(r.created_at)} · *${r.purpose}* · signed by \`${shortAddr(r.signer_pubkey)}\``,
    );
  }
  lines.push(
    "",
    "_Anything here you don't recognize? Run /lock 24 immediately._",
  );

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
