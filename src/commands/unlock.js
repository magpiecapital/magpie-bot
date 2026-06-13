/**
 * /unlock — show the user what they could borrow against their existing bags.
 *
 * This is the highest-ROI conversion lever: the bot already knows
 * which approved-collateral tokens the user holds AND the live prices.
 * Showing them the SOL they could unlock — without selling — converts
 * passive holders into active borrowers.
 *
 * Output: a ranked list of their holdings (by borrow-potential SOL),
 * with a clean per-token "unlock X SOL at Standard tier" line and a
 * direct /borrow CTA.
 */
import { InlineKeyboard } from "grammy";
import { upsertUser } from "../services/users.js";
import { ensureWallet } from "../services/wallet.js";
import { getSupportedBalances } from "../services/deposits.js";
import { collateralValueLamports } from "../services/price.js";
import { getLoanLimits } from "../services/loan-limits.js";
import { getEligibleTiers, MEMECOIN_TIERS } from "../services/loan-tier-resolver.js";

// Memecoin-tier shape for the headline "Standard tier" framing. Mixed-
// category holdings (some memecoin, some RWA) get headlined as memecoin
// Standard since that's the conservative case; per-holding lines below
// resolve each token's correct tier set.
const STANDARD = {
  name: MEMECOIN_TIERS[2].label.split(" ")[0] || "Standard",
  ltv: MEMECOIN_TIERS[2].ltv,
  days: MEMECOIN_TIERS[2].days,
  feeBps: MEMECOIN_TIERS[2].feeBps,
};

function fmtSol(n) {
  if (n < 0.001) return "<0.001";
  if (n < 1) return n.toFixed(4);
  if (n < 100) return n.toFixed(3);
  return n.toFixed(1);
}

function fmtUsdEquivalent(sol, solUsd) {
  if (!solUsd || !sol) return "";
  const usd = sol * solUsd;
  if (usd < 1) return `~$${usd.toFixed(2)}`;
  return `~$${Math.round(usd).toLocaleString()}`;
}

export async function handleUnlock(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;
  const user = await upsertUser(tgUser.id, tgUser.username);
  const { publicKey } = await ensureWallet(user.id);

  // Fetch their balances + a SOL/USD price for context
  const balances = await getSupportedBalances(publicKey);

  if (balances.length === 0) {
    const kb = new InlineKeyboard()
      .text("📥 Show me deposit address", "fallback:deposit")
      .row()
      .text("📋 Supported tokens", "start:supported");
    return ctx.reply(
      [
        "🔓 *Unlock SOL — no bags yet*",
        "",
        "I don't see any approved collateral tokens in your Magpie wallet.",
        "",
        "*To get started:*",
        "1. Tap *Show me deposit address* — copy your wallet address",
        "2. Send memecoins from Phantom/Solflare to that address",
        "3. Also send ~0.01 SOL for transaction fees",
        "4. Come back to /unlock — I'll show you what you can borrow",
        "",
        "Or run /import to use your existing wallet directly.",
      ].join("\n"),
      { parse_mode: "Markdown", reply_markup: kb },
    );
  }

  // Compute borrow potential for each token. Resolve per-token tiers so
  // RWA holdings show their higher-LTV ladder while memecoins show the
  // existing 30/25/20 ladder. getSupportedBalances exposes `category`
  // since the tier-resolver wiring (PR #108).
  const enriched = await Promise.all(balances.map(async (b) => {
    let valueLamports = null;
    try {
      valueLamports = await collateralValueLamports(
        b.mint,
        BigInt(b.rawAmount),
        b.decimals,
      );
    } catch { /* fall through */ }
    const valueSol = valueLamports != null ? Number(valueLamports) / 1e9 : null;
    const tierSet = await getEligibleTiers({ category: b.category });
    return {
      ...b,
      valueSol,
      tierSet,
      // Borrow at each tier (post-fee receive)
      tiers: valueSol != null
        ? tierSet.map((t) => {
            const gross = valueSol * (t.ltv / 100);
            const fee = gross * (t.feeBps / 10_000);
            return {
              name: t.label.split(" ")[0] || t.label,
              ltv: t.ltv, days: t.days, feeBps: t.feeBps,
              receiveSol: gross - fee, repaySol: gross,
            };
          })
        : null,
    };
  }));

  // Rank by last-tier-in-set (safest = lowest LTV for memecoin, highest
  // for RWA — both represent the longest-term "safest" option per category).
  const safestIdx = (e) => e.tiers ? e.tiers.length - 1 : 0;
  enriched.sort((a, b) => {
    const av = a.tiers ? a.tiers[safestIdx(a)].receiveSol : -1;
    const bv = b.tiers ? b.tiers[safestIdx(b)].receiveSol : -1;
    return bv - av;
  });

  // Total potential on each holding's last tier (with per-wallet limits respected)
  const limits = await getLoanLimits(user.id);
  const maxOutstandingSol = Number(limits.maxOutstanding) / 1e9;
  const availableSol = Number(limits.availableToBorrow) / 1e9;

  const totalPotentialSol = enriched.reduce((acc, e) => {
    if (!e.tiers) return acc;
    return acc + e.tiers[safestIdx(e)].receiveSol;
  }, 0);
  // What they could ACTUALLY borrow given limits
  const realisticPotentialSol = Math.min(totalPotentialSol, availableSol);

  const lines = [
    "🔓 *Your borrow potential*",
    "",
    `If you borrowed against your bags right now on *Standard* tier (${STANDARD.ltv}% LTV · ${STANDARD.days}d · ${(STANDARD.feeBps / 100).toFixed(2)}% fee):`,
    "",
    `*Up to \`${fmtSol(realisticPotentialSol)} SOL\`* available to you right now`,
  ];

  if (realisticPotentialSol < totalPotentialSol) {
    lines.push(
      `_(Your bags could unlock ${fmtSol(totalPotentialSol)} SOL but your ${limits.tier}-tier limit caps it at ${fmtSol(maxOutstandingSol)} SOL outstanding.)_`,
    );
  }

  lines.push("");
  lines.push("*By token:*");

  let shown = 0;
  for (const t of enriched) {
    if (shown >= 5) break; // cap display at top 5
    if (!t.tiers) {
      lines.push(`• \`${t.humanAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${t.symbol}\` — _price feed unavailable_`);
      shown++;
      continue;
    }
    // Use first + last in the resolved set so the line works for both
    // memecoin (Express/Standard) and RWA (RWA Express/RWA Standard).
    const std = t.tiers[t.tiers.length - 1];
    if (std.receiveSol < 0.001) continue; // skip dust
    const expr = t.tiers[0];
    lines.push(
      `• *${t.symbol}* — \`${t.humanAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })}\` tokens`,
      `  → Up to \`${fmtSol(std.receiveSol)} SOL\` (${std.name}) · \`${fmtSol(expr.receiveSol)} SOL\` (${expr.name})`,
    );
    shown++;
  }

  // The "cheaper than selling" framing — re-frames the mental model
  if (realisticPotentialSol > 0.01) {
    const estSellSlippageSol = totalPotentialSol * (1 / STANDARD.ltv / 100) * 0.02; // rough back-calc
    // Simpler: just use 2% of total collateral value
    const totalCollateralSol = enriched.reduce((acc, e) => acc + (e.valueSol || 0), 0);
    const sellSlippageSol = totalCollateralSol * 0.02;
    const standardFeeSol = realisticPotentialSol * (STANDARD.feeBps / 10_000);

    lines.push(
      "",
      "*Why borrow instead of sell?*",
      `• Selling all your bags = ~${fmtSol(sellSlippageSol)} SOL slippage + a taxable event`,
      `• Borrowing on Standard = ~${fmtSol(standardFeeSol)} SOL fee, no tax event, keep every token`,
    );
    void estSellSlippageSol; // silence unused
  }

  const kb = new InlineKeyboard()
    .text("💰 Borrow now", "start:borrow")
    .row()
    .text("🧮 Tweak amounts (/simulate)", "unlock:sim")
    .row()
    .text("🛡 Auto-Protect", "autoprotect:status");

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: kb,
  }).catch(async () => {
    // Markdown fallback — token names/symbols can have edge cases
    await ctx.reply(lines.join("\n").replace(/[*_`]/g, ""), { reply_markup: kb });
  });
}

export function registerUnlockCallbacks(bot) {
  bot.callbackQuery("unlock:sim", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      [
        "🧮 *Run a simulation*",
        "",
        "Usage: `/simulate <symbol> <amount>`",
        "",
        "Example: `/simulate WIF 1000` — see exactly what you'd get",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });
}
