/**
 * /lend — P2P Lending Marketplace commands
 *
 * Subcommands:
 *   /lend create   — Create a new lending pool
 *   /lend deposit  — Deposit SOL into your pool
 *   /lend withdraw — Withdraw from your pool
 *   /lend pools    — View your lending pools
 *   /lend browse   — Browse available pools (for borrowers)
 *   /lend stats    — Marketplace statistics
 */
import { findUserByTelegramId } from "../services/users.js";
import {
  createPool,
  depositToPool,
  withdrawFromPool,
  getMyPools,
  getPoolDetails,
  browseAvailablePools,
  getMarketplaceStats,
} from "../services/p2p-marketplace.js";
import { getCreditScore } from "../services/credit-score.js";
import { InlineKeyboard } from "grammy";

function formatSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

function formatApyBps(bps) {
  return (Number(bps) / 100).toFixed(1) + "%";
}

const TRANCHE_EMOJI = { senior: "🛡️", mezzanine: "⚖️", junior: "🔥" };

export async function handleLend(ctx) {
  const user = await findUserByTelegramId(ctx.from.id);
  if (!user) return ctx.reply("Please /start first.");

  const args = ctx.message.text.split(/\s+/).slice(1);
  const subcommand = args[0]?.toLowerCase();

  try {
    switch (subcommand) {
      case "create":
        return handleCreate(ctx, user, args.slice(1));
      case "deposit":
        return handleDeposit(ctx, user, args.slice(1));
      case "withdraw":
        return handleWithdrawCmd(ctx, user, args.slice(1));
      case "pools":
        return handleMyPools(ctx, user);
      case "browse":
        return handleBrowse(ctx, user, args.slice(1));
      case "stats":
        return handleMarketStats(ctx);
      default:
        return showHelp(ctx);
    }
  } catch (err) {
    console.error("[lend] Error:", err);
    // Try the tx translator first (handles common Solana patterns).
    // Falls back to a generic clean message.
    try {
      const { translateTxError } = await import("../services/tx-error-translator.js");
      const friendly = translateTxError(err, { flow: "lend" });
      return ctx.reply(friendly, { parse_mode: "Markdown" });
    } catch {
      return ctx.reply(
        [
          "⚠️ *Lending command failed*",
          "",
          "Something went wrong. Try the command again, or /support → Chat with agent.",
        ].join("\n"),
        { parse_mode: "Markdown" },
      );
    }
  }
}

async function showHelp(ctx) {
  return ctx.reply(
    `🏦 <b>P2P Lending Marketplace</b>\n\n` +
    `<b>For Lenders:</b>\n` +
    `/lend create &lt;tranche&gt; — Create pool (senior/junior/mezzanine)\n` +
    `/lend deposit &lt;pool_id&gt; &lt;sol&gt; — Deposit SOL into pool\n` +
    `/lend withdraw &lt;pool_id&gt; &lt;sol&gt; — Withdraw from pool\n` +
    `/lend pools — View your pools\n\n` +
    `<b>For Everyone:</b>\n` +
    `/lend browse — See available lending pools\n` +
    `/lend stats — Marketplace statistics\n\n` +
    `<b>Tranches:</b>\n` +
    `🛡️ Senior — Lower yield, protected from first losses\n` +
    `⚖️ Mezzanine — Moderate risk/reward\n` +
    `🔥 Junior — Higher yield, absorbs losses first`,
    { parse_mode: "HTML" },
  );
}

async function handleCreate(ctx, user, args) {
  const tranche = args[0]?.toLowerCase() || "senior";
  if (!["senior", "mezzanine", "junior"].includes(tranche)) {
    return ctx.reply("Invalid tranche. Choose: senior, mezzanine, or junior");
  }

  // Default settings per tranche
  const defaults = {
    senior: { minApy: 500, maxApy: 1500, minCredit: 500, maxLtv: 25, maxDays: 7 },
    mezzanine: { minApy: 1000, maxApy: 3000, minCredit: 400, maxLtv: 30, maxDays: 14 },
    junior: { minApy: 2000, maxApy: 5000, minCredit: 300, maxLtv: 35, maxDays: 30 },
  };
  const d = defaults[tranche];

  const pool = await createPool(user.id, {
    name: `${user.telegram_username || "anon"}-${tranche}`,
    tranche,
    minApyBps: d.minApy,
    maxApyBps: d.maxApy,
    minCreditScore: d.minCredit,
    maxLtv: d.maxLtv,
    maxDurationDays: d.maxDays,
  });

  return ctx.reply(
    `${TRANCHE_EMOJI[tranche]} <b>Lending Pool Created!</b>\n\n` +
    `Pool ID: <code>${pool.id}</code>\n` +
    `Tranche: ${tranche.charAt(0).toUpperCase() + tranche.slice(1)}\n` +
    `Min APY: ${formatApyBps(d.minApy)}\n` +
    `Min Credit Score: ${d.minCredit}\n` +
    `Max LTV: ${d.maxLtv}%\n` +
    `Max Duration: ${d.maxDays} days\n\n` +
    `Deposit SOL with:\n` +
    `/lend deposit ${pool.id} <amount>`,
    { parse_mode: "HTML" },
  );
}

async function handleDeposit(ctx, user, args) {
  const poolId = parseInt(args[0]);
  const solAmount = parseFloat(args[1]);

  if (!poolId || !solAmount || solAmount <= 0) {
    return ctx.reply("Usage: /lend deposit <pool_id> <sol_amount>\n\nExample: /lend deposit 1 5.0");
  }

  const lamports = Math.floor(solAmount * 1e9).toString();
  const result = await depositToPool(poolId, user.id, lamports);

  return ctx.reply(
    `✅ <b>Deposited ${solAmount} SOL</b> into pool #${poolId}\n\n` +
    `Your funds are now available for borrower matching.`,
    { parse_mode: "HTML" },
  );
}

async function handleWithdrawCmd(ctx, user, args) {
  const poolId = parseInt(args[0]);
  const solAmount = parseFloat(args[1]);

  if (!poolId || !solAmount || solAmount <= 0) {
    return ctx.reply("Usage: /lend withdraw <pool_id> <sol_amount>");
  }

  const lamports = Math.floor(solAmount * 1e9).toString();
  const result = await withdrawFromPool(poolId, user.id, lamports);

  return ctx.reply(
    `✅ <b>Withdrawn from pool #${poolId}</b>\n\n` +
    `Principal: ${formatSol(result.principalLamports)} SOL\n` +
    `Yield earned: ${formatSol(result.yieldLamports)} SOL`,
    { parse_mode: "HTML" },
  );
}

async function handleMyPools(ctx, user) {
  const pools = await getMyPools(user.id);
  if (pools.length === 0) {
    return ctx.reply(
      "You don't have any lending pools yet.\n\nCreate one with /lend create <tranche>",
    );
  }

  let msg = `🏦 <b>Your Lending Pools</b>\n`;
  for (const p of pools) {
    const emoji = TRANCHE_EMOJI[p.tranche] || "📦";
    msg += `\n${emoji} <b>Pool #${p.id}</b> — ${p.tranche}\n`;
    msg += `  Deposited: ${formatSol(p.total_deposited_lamports)} SOL\n`;
    msg += `  Available: ${formatSol(p.available_lamports)} SOL\n`;
    msg += `  Locked: ${formatSol(p.locked_lamports)} SOL\n`;
    msg += `  Yield: ${formatSol(p.earned_yield_lamports)} SOL\n`;
    msg += `  Status: ${p.status}\n`;
  }

  return ctx.reply(msg, { parse_mode: "HTML" });
}

async function handleBrowse(ctx, user, args) {
  const creditScore = await getCreditScore(user.id);
  const score = creditScore?.score || 300;

  const pools = await browseAvailablePools({
    creditScore: score,
    tranche: args[0]?.toLowerCase(),
  });

  if (pools.length === 0) {
    return ctx.reply("No lending pools available matching your criteria.");
  }

  let msg = `🔍 <b>Available Lending Pools</b>\n`;
  msg += `Your credit score: ${score}\n`;

  for (const p of pools.slice(0, 10)) {
    const emoji = TRANCHE_EMOJI[p.tranche] || "📦";
    msg += `\n${emoji} <b>Pool #${p.id}</b>\n`;
    msg += `  Tranche: ${p.tranche} | Available: ${formatSol(p.available_lamports)} SOL\n`;
    msg += `  APY: ${formatApyBps(p.min_apy_bps)}-${formatApyBps(p.max_apy_bps)}\n`;
    msg += `  Min Credit: ${p.min_credit_score} | Max LTV: ${p.max_ltv}%\n`;
  }

  return ctx.reply(msg, { parse_mode: "HTML" });
}

async function handleMarketStats(ctx) {
  const stats = await getMarketplaceStats();
  if (!stats) return ctx.reply("Marketplace stats not yet available.");

  return ctx.reply(
    `📊 <b>P2P Marketplace Stats</b>\n\n` +
    `Active Pools: ${stats.total_pools}\n` +
    `Total TVL: ${formatSol(stats.total_tvl_lamports)} SOL\n` +
    `Loans Matched: ${stats.total_loans_matched}\n` +
    `Average APY: ${formatApyBps(stats.avg_apy_bps)}\n\n` +
    `<b>By Tranche:</b>\n` +
    `🛡️ Senior TVL: ${formatSol(stats.senior_tvl_lamports)} SOL\n` +
    `🔥 Junior TVL: ${formatSol(stats.junior_tvl_lamports)} SOL`,
    { parse_mode: "HTML" },
  );
}

export function registerLendCallbacks(bot) {
  // Future: inline keyboard callbacks for pool interactions
}
