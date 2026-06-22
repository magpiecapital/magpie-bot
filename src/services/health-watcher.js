/**
 * Progressive health-alert watcher.
 *
 * For every active loan, compute its current collateral-value-to-owed ratio.
 * When the ratio crosses a warning threshold downward for the first time, DM
 * the user with actionable context (repay button, add-collateral hint).
 *
 * Thresholds (descending): 1.3x (yellow), 1.2x (orange), 1.1x (red — imminent
 * liquidation). `loans.last_health_alert` stores the lowest threshold we've
 * already sent, so recovery + re-drop still produces a fresh alert only when
 * crossing a lower threshold we haven't warned about.
 */
import { InlineKeyboard } from "grammy";
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { collateralValueLamports } from "./price.js";
import { getPrefs } from "./prefs.js";
import { connection } from "../solana/connection.js";
import { getSupportedBalances } from "./deposits.js";

/**
 * Look at the user's wallet and recommend the ONE best action to take
 * given their loan's current health and what they actually hold.
 *
 *   • Have enough idle SOL to partial-repay back to safe? → /partialrepay
 *   • Have more of the same collateral token in wallet? → /topup
 *   • Have neither but loan isn't imminent? → /extend
 *   • Have neither and loan is imminent? → /repay full (deposit + repay)
 */
async function recommendAction(userId, loan, healthRatio, owedLamports, collateralLamports) {
  try {
    const { rows: [w] } = await query(
      `SELECT public_key FROM wallets WHERE user_id = $1`,
      [userId],
    );
    if (!w?.public_key) return null;
    const pubkey = new PublicKey(w.public_key);

    // Idle SOL
    let solLamports = 0n;
    try {
      solLamports = BigInt(await connection.getBalance(pubkey));
    } catch { /* fall through */ }

    // To bring health from current to 1.5x via partial repay:
    //   newOwed = collateral / 1.5x
    //   need to pay = owed - newOwed
    const targetOwed = BigInt(Math.floor(Number(collateralLamports) / 1.5));
    const owedBig = BigInt(owedLamports);
    const partialRepayNeeded = owedBig > targetOwed ? owedBig - targetOwed : 0n;
    const GAS_RESERVE = 3_000_000n;

    if (solLamports > partialRepayNeeded + GAS_RESERVE && partialRepayNeeded > 0n) {
      const partialSol = (Number(partialRepayNeeded) / 1e9).toFixed(4);
      return {
        action: "partialrepay",
        text: `You have \`${(Number(solLamports) / 1e9).toFixed(4)} SOL\` idle in your wallet. /partialrepay ~\`${partialSol} SOL\` to bring health back above 1.5x — keeps your collateral locked but reduces risk.`,
      };
    }

    // Do they have more of the same collateral token they could top up with?
    try {
      const balances = await getSupportedBalances(w.public_key);
      const sameToken = balances.find((b) => b.mint === loan.collateral_mint);
      if (sameToken && Number(sameToken.rawAmount) > 0) {
        return {
          action: "topup",
          text: `You have \`${sameToken.humanAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${sameToken.symbol}\` idle in your wallet. /topup that loan with more collateral — free besides ~0.001 SOL gas, lowers your effective LTV immediately.`,
        };
      }
    } catch { /* RPC blip, fall through to generic */ }

    // Imminent (< 1.2x)? Recommend full repay if they can fund it,
    // otherwise extend buys time.
    if (healthRatio < 1.2) {
      return {
        action: "deposit_repay",
        text: `Health is in the danger zone. Either /deposit more SOL and /repay in full, or /extend to push the due date out and give yourself breathing room.`,
      };
    }

    // Default: extend is the cheapest stall option
    return {
      action: "extend",
      text: `No idle SOL or extra collateral in your wallet. /extend pushes the due date out for a small fee — buys you time to figure out next steps.`,
    };
  } catch (err) {
    console.warn("[health-watcher] recommend failed:", err.message);
    return null;
  }
}

const POLL_INTERVAL_MS = Number(process.env.HEALTH_WATCH_MS) || 120_000;

const THRESHOLDS = [
  // Tier 0: early heads-up. Not alarming, just informational. Gives users
  // a chance to act calmly before things actually get tight.
  { ratio: 1.5, emoji: "🟢", label: "Heads up — your loan health dipped below 1.5x." },
  { ratio: 1.3, emoji: "🟡", label: "Your loan health is getting tight." },
  { ratio: 1.2, emoji: "🟠", label: "Your loan is close to liquidation." },
  { ratio: 1.1, emoji: "🔴", label: "Imminent liquidation risk." },
];

function alertFor(ratio, lastAlertedAt, ltvPercentage = null) {
  // Compute starting health for this loan based on its LTV. A loan at
  // 70% LTV starts at 1/0.70 ≈ 1.43x — already BELOW our 1.5x "heads up"
  // threshold. Without this gate, every 70% LTV RWA loan would fire a
  // health alert the moment it was borrowed, regardless of price action.
  // Operator-reported 2026-06-15 after the first SPCX 70% LTV V4 borrow
  // triggered an immediate health DM.
  //
  // Rule: skip any threshold that is >= the loan's STARTING health. The
  // alert should fire on a meaningful drop FROM origination, not on a
  // condition that was true at borrow time.
  const startingHealth = ltvPercentage && ltvPercentage > 0
    ? 100 / ltvPercentage
    : null;

  for (const t of THRESHOLDS) {
    // Skip thresholds at or above starting health — they'd fire on a
    // flat or even slightly-up market. Annoying, not informative.
    if (startingHealth != null && t.ratio >= startingHealth) continue;
    if (ratio < t.ratio) {
      if (lastAlertedAt == null || Number(lastAlertedAt) > t.ratio) {
        return t;
      }
    }
  }
  return null;
}

async function checkLoan(bot, row) {
  const decimals = row.decimals;
  if (decimals == null) return; // unsupported mint — can't price

  let valueLamports;
  try {
    valueLamports = await collateralValueLamports(
      row.collateral_mint,
      row.collateral_amount,
      decimals,
    );
  } catch {
    return;
  }

  const owed = Number(row.original_loan_amount_lamports);
  if (owed <= 0) return;
  const ratio = valueLamports / owed;

  const alert = alertFor(ratio, row.last_health_alert);
  if (!alert) return;

  const prefs = await getPrefs(row.user_id);
  if (!prefs.notify_health) {
    // Respect opt-out, but still record the threshold crossing so we don't
    // spam later if they re-enable.
    await query(`UPDATE loans SET last_health_alert = $2 WHERE id = $1`, [
      row.id,
      alert.ratio,
    ]);
    return;
  }

  // Personalize the recommendation based on what the user actually
  // has in their wallet — idle SOL vs extra collateral vs neither.
  // Slow path (RPC calls); silently falls back to generic if it fails.
  const rec = await recommendAction(row.user_id, row, ratio, owed, valueLamports);

  // Order the inline-keyboard so the recommended action comes first.
  const kb = new InlineKeyboard();
  if (rec?.action === "partialrepay") {
    kb.text("💰 Partial repay", `partialrepay:loan:${row.id}`)
      .text("✕", "fallback:dismiss")
      .row()
      .text("Other: /repay /topup /extend", "fallback:noop");
  } else if (rec?.action === "topup") {
    kb.text("➕ Top up collateral", `topup:loan:${row.id}`)
      .text("✕", "fallback:dismiss")
      .row()
      .text("Other: /repay /partialrepay /extend", "fallback:noop");
  } else if (rec?.action === "extend") {
    kb.text("⏱ Extend term", `extend:loan:${row.id}`)
      .text("✕", "fallback:dismiss")
      .row()
      .text("Other: /repay /partialrepay /topup", "fallback:noop");
  } else {
    // Imminent or unknown — full menu
    kb.text("🔧 Repay now", `repay:loan:${row.id}`)
      .text("➕ Top up", `topup:loan:${row.id}`)
      .row()
      .text("⏱ Extend", `extend:loan:${row.id}`);
  }

  // ── Build the alert with clearer surface ──
  // 1. Symbol on the loan line so the user immediately sees WHICH token
  //    is at risk (operator complaint 2026-06-11 — alert didn't say
  //    what token).
  // 2. Loan number is a Markdown link that drops the user directly on
  //    the loan card in the dashboard. The dashboard reads ?loan=<id>
  //    on mount and scrolls + highlights that card.
  // 3. If the user has multiple wallets we surface which one this loan
  //    belongs to. Single-wallet users see no wallet line.
  const symbol = row.symbol || row.collateral_mint?.slice(0, 4) + "…";
  // Deep link to the dashboard with the on-chain loan_id. The site
  // reads ?loan= and scrolls to the card with matching loan_id.
  const dashUrl = `https://magpie.capital/dashboard?loan=${encodeURIComponent(row.loan_id)}`;
  const loanLine = `[Loan #${row.loan_id}](${dashUrl}) — ${symbol} — health *${ratio.toFixed(2)}x*`;

  // Wallet line — only for multi-wallet users.
  let walletLine = null;
  if ((row.wallet_count ?? 1) > 1) {
    const label = row.wallet_label || "Magpie wallet";
    const shortPk = row.borrower_wallet
      ? `${row.borrower_wallet.slice(0, 4)}…${row.borrower_wallet.slice(-4)}`
      : null;
    walletLine = shortPk
      ? `Wallet: \`${label} (${shortPk})\``
      : `Wallet: \`${label}\``;
  }

  const msg = [
    `${alert.emoji} *Loan health alert*`,
    "",
    `${alert.label}`,
    "",
    loanLine,
    walletLine,
    `Collateral value: \`${(valueLamports / 1e9).toFixed(4)} SOL\``,
    `Owed: \`${(owed / 1e9).toFixed(4)} SOL\``,
    "",
    rec ? `*Recommended:* ${rec.text}` : "Options: /repay · /partialrepay · /topup collateral · /extend",
  ].filter((s) => s !== null).join("\n");

  try {
    await bot.api.sendMessage(row.telegram_id, msg, {
      parse_mode: "Markdown",
      reply_markup: kb,
      // Suppress the big card from the magpie.capital dashboard link
      // so the alert stays compact.
      disable_web_page_preview: true,
    });
    await query(`UPDATE loans SET last_health_alert = $2 WHERE id = $1`, [
      row.id,
      alert.ratio,
    ]);
  } catch (err) {
    console.error(`[health-watcher] DM failed for loan ${row.loan_id}: ${err.message}`);
  }
}

export function startHealthWatcher(bot) {
  console.log(`🩺 Health watcher running (every ${POLL_INTERVAL_MS / 1000}s)`);

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { rows } = await query(
        // wallet_count + wallet_label / wallet_pubkey: lets the alert say
        // which wallet a loan belongs to when the user has more than one.
        // For multi-wallet users we surface either the user-set label OR
        // (when labels are all the default 'Magpie wallet') a short pubkey
        // prefix so they can tell wallets apart. Single-wallet users see
        // no wallet line — would be noise.
        // sm.symbol: collateral token symbol so the user can immediately
        // see what's at risk without having to look up the mint.
        `SELECT l.id, l.loan_id, l.user_id, l.collateral_mint, l.collateral_amount,
                l.original_loan_amount_lamports, l.last_health_alert,
                l.borrower_wallet,
                u.telegram_id,
                sm.decimals, sm.symbol,
                w.label AS wallet_label,
                (SELECT COUNT(*)::int FROM wallets ww WHERE ww.user_id = u.id) AS wallet_count
         FROM loans l
         JOIN users u ON u.id = l.user_id
         LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
         LEFT JOIN wallets w ON w.user_id = u.id AND w.public_key = l.borrower_wallet
         WHERE l.status = 'active'`,
      );
      // Serialise per-loan checks so we don't hammer the price API.
      for (const row of rows) {
        await checkLoan(bot, row);
      }
    } catch (err) {
      console.error("[health-watcher] cycle error:", err.message);
    } finally {
      running = false;
    }
  };

  tick();
  return setInterval(tick, POLL_INTERVAL_MS);
}
