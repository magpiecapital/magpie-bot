/**
 * /me — single-screen personal summary: wallet balance, reputation tier,
 * referral code, and lifetime stats.
 */
import { upsertUser } from "../services/users.js";
import { ensureWallet } from "../services/wallet.js";
import { getSolBalance } from "../services/deposits.js";
import { tierFor, nextTierHint, getUserStats } from "../services/reputation.js";
import { getOrCreateCode, referralStats } from "../services/referrals.js";
import { query } from "../db/pool.js";

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

export async function handleMe(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;

  const user = await upsertUser(tgUser.id, tgUser.username);
  const { publicKey } = await ensureWallet(user.id);

  const [sol, stats, code, refs, activeRow, botInfo] = await Promise.all([
    getSolBalance(publicKey),
    getUserStats(user.id),
    getOrCreateCode(user.id),
    referralStats(user.id),
    query(`SELECT COUNT(*)::int AS n FROM loans WHERE user_id = $1 AND status = 'active'`, [user.id]),
    ctx.api.getMe(),
  ]);

  const tier = tierFor(stats);
  const hint = nextTierHint(stats);
  const shareLink = `https://t.me/${botInfo.username}?start=${code}`;

  const lines = [
    `👤 *${tgUser.username ? "@" + tgUser.username : "You"}*`,
    "",
    `Tier: ${tier.emoji} *${tier.label}*`,
  ];
  if (hint) {
    lines.push(`  ↳ ${hint.repaysNeeded} more repay(s) → ${hint.next.emoji} ${hint.next.label}`);
  }
  lines.push(
    "",
    "*Wallet*",
    `\`${publicKey}\``,
    `Balance: ${fmtSol(sol)} SOL`,
    `Active loans: ${activeRow.rows[0].n}`,
    "",
    "*Lifetime stats*",
    `Loans repaid:      ${stats.repaid_count}`,
    `Loans liquidated:  ${stats.liquidated_count}`,
    `Total borrowed:    ${fmtSol(stats.total_borrowed_lamports)} SOL`,
    "",
    "*Referrals*",
    `Code: \`${code}\``,
    `Share: ${shareLink}`,
    `Referred: ${refs.total}`,
  );

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}
