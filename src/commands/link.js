/**
 * /link <code> — claim a site-generated link code, attaching a wallet
 * the user controls externally (e.g. their Phantom) to their TG account.
 *
 * Flow:
 *   1. User connects Phantom on magpie.capital, clicks "Link to Telegram"
 *   2. Site calls POST /api/v1/link/request, gets back a code
 *   3. User pastes "/link <code>" here
 *   4. This handler claims the code + adds the wallet to wallets table
 *
 * After linking, both surfaces operate on the same Magpie account —
 * the site sees the user's TG-tied data (referrals, holder history,
 * AI conversations) via shared user_id, and TG can /wallets switch to
 * the externally-held wallet for borrow/repay actions.
 */
import { upsertUser } from "../services/users.js";
import { claimLinkCode } from "../api/account-link.js";
import { query } from "../db/pool.js";

export async function handleLink(ctx) {
  const arg = ctx.message?.text?.split(/\s+/)[1];
  if (!arg) {
    return ctx.reply(
      "*Link a wallet from magpie.capital*\n\n" +
      "Usage: `/link <code>`\n\n" +
      "First generate a code on the site:\n" +
      "1. Go to magpie.capital/dashboard\n" +
      "2. Connect the wallet you want to link\n" +
      "3. Click *Link to Telegram* — copy the code\n" +
      "4. Paste it here as `/link <code>`",
      { parse_mode: "Markdown" },
    );
  }

  const user = await upsertUser(ctx.from.id, ctx.from.username);

  const wallet = await claimLinkCode(arg.trim(), user.id);
  if (!wallet) {
    return ctx.reply(
      "❌ Invalid or expired code.\n\n" +
      "Codes expire after 15 minutes. Generate a new one on magpie.capital/dashboard and try again.",
      { parse_mode: "Markdown" },
    );
  }

  // Check if this wallet is already in the user's wallets table.
  const { rows: existing } = await query(
    `SELECT id, is_active FROM wallets WHERE user_id = $1 AND public_key = $2`,
    [user.id, wallet],
  );

  if (existing.length > 0) {
    return ctx.reply(
      `✅ Wallet \`${wallet}\` is already linked to your account.`,
      { parse_mode: "Markdown" },
    );
  }

  // Enforce the existing 10-wallet cap per user.
  const { rows: countRow } = await query(
    `SELECT COUNT(*)::int AS n FROM wallets WHERE user_id = $1`,
    [user.id],
  );
  if (countRow[0].n >= 10) {
    return ctx.reply(
      "❌ You already have 10 wallets linked (the per-user cap).\n\n" +
      "Use /wallets to review them — you can remove one with `🗑 Remove from account` before linking another.",
      { parse_mode: "Markdown" },
    );
  }

  // Add the wallet as non-active (so we don't surprise the user by switching
  // their borrow/repay default). They can /wallets switch later.
  // source='site-link' so we can audit how the wallet got into the account.
  await query(
    `INSERT INTO wallets (user_id, public_key, is_active, source, created_at)
     VALUES ($1, $2, FALSE, 'site-link', NOW())`,
    [user.id, wallet],
  );

  return ctx.reply(
    [
      `✅ *Wallet linked*`,
      ``,
      `\`${wallet}\``,
      ``,
      `This wallet is now part of your Magpie account. From either surface you'll see your loans, referrals, and holdings unified.`,
      ``,
      `_The newly linked wallet is NOT active by default — use /wallets to switch to it if you want bot actions (/borrow, /repay) to sign from it._`,
    ].join("\n"),
    { parse_mode: "Markdown" },
  );
}
