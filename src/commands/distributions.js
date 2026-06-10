/**
 * /distributions — show the user's full holder-distribution history
 * directly in the Telegram bot, mirroring the dashboard's Holder
 * Distributions card.
 *
 * Lists every MGP-XXX round the wallet has received SOL from, with
 * amount, date, running cumulative total, and a Solscan tx link
 * tied to each row.
 *
 * Works for ANY of the user's linked wallets — fans out across all
 * of them and sums everything together. So if a user borrowed against
 * \$MAGPIE collateral with one wallet AND held \$MAGPIE in another,
 * they see BOTH distributions in one place.
 */
import { upsertUser } from "../services/users.js";
import { ensureWallet } from "../services/wallet.js";
import { query } from "../db/pool.js";

const SITE_URL = process.env.MAGPIE_SITE_URL || "https://magpie.capital";

function fmtSol(lamports) {
  const n = Number(lamports) / 1e9;
  if (n === 0) return "0";
  return n.toFixed(6).replace(/\.?0+$/, "");
}

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export async function handleDistributions(ctx) {
  const tgUser = ctx.from;
  if (!tgUser) return;

  const user = await upsertUser(tgUser.id, tgUser.username);

  // All wallets owned by this user
  const { rows: walletRows } = await query(
    `SELECT public_key FROM wallets WHERE user_id = $1`,
    [user.id],
  );
  if (walletRows.length === 0) {
    return ctx.reply(
      "No wallet linked yet. Run /start to set up your Magpie wallet — once you have \$MAGPIE in it at a snapshot, you'll show up here.",
    );
  }
  const walletPubkeys = walletRows.map((r) => r.public_key);

  // Pull every distribution row across all the user's wallets
  const { rows: dists } = await query(
    `SELECT proposal_id,
            allocated_lamports::text AS lamports,
            tx_signature, sent_at, status, wallet
       FROM governance_distributions
      WHERE wallet = ANY($1::text[])
      ORDER BY COALESCE(sent_at, created_at) ASC NULLS LAST`,
    [walletPubkeys],
  );

  if (dists.length === 0) {
    return ctx.reply(
      "No holder distributions yet for the wallet(s) linked to this account.\n\n" +
        "Hold \$MAGPIE (or have it locked as collateral on a Magpie loan) at the next snapshot — both count 1:1 — and your share will land in your wallet automatically.\n\n" +
        `Full view: ${SITE_URL}/dashboard`,
    );
  }

  // Build running cumulative for sent rows only
  let cumulative = 0n;
  const lines = [];
  lines.push("*Your Holder Distributions*");
  lines.push("");

  const sent = dists.filter((d) => d.status === "sent");
  const pending = dists.filter((d) => d.status === "pending");
  const unpayable = dists.filter((d) => d.status === "unpayable_rent_exempt");

  // Sent rows: oldest-first for cumulative math, then we print
  for (const d of sent) {
    cumulative += BigInt(d.lamports);
  }
  const lifetimeTotal = cumulative;

  lines.push(`Lifetime received: *${fmtSol(lifetimeTotal.toString())} SOL* across ${sent.length} distribution${sent.length === 1 ? "" : "s"}`);
  lines.push("");

  if (sent.length > 0) {
    lines.push("───────────────");
    // Reset and walk again to display each row with its running total
    let running = 0n;
    for (const d of sent) {
      running += BigInt(d.lamports);
      lines.push(`*${d.proposal_id}* — ${fmtSol(d.lamports)} SOL`);
      lines.push(`Sent ${fmtDate(d.sent_at)} · lifetime ${fmtSol(running.toString())} SOL`);
      if (d.tx_signature) {
        lines.push(`Proof: https://solscan.io/tx/${d.tx_signature}`);
      }
      lines.push("");
    }
  }

  if (pending.length > 0) {
    lines.push("*Pending* (not yet sent on-chain):");
    for (const d of pending) {
      lines.push(`${d.proposal_id} — ${fmtSol(d.lamports)} SOL (round hasn't executed)`);
    }
    lines.push("");
  }

  if (unpayable.length > 0) {
    lines.push(
      `${unpayable.length} round(s) were below Solana's rent-exempt minimum — unpayable to wallets not yet initialized on-chain.`,
    );
    lines.push("");
  }

  lines.push(`Full dashboard view: ${SITE_URL}/dashboard`);

  return ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}
