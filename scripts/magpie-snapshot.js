#!/usr/bin/env node
/**
 * One-shot $MAGPIE holder snapshot — augmented with active-loan borrowers.
 *
 * Standard token-account enumeration misses borrowers whose $MAGPIE is
 * currently locked in a loan's escrow vault (the vault appears to "hold"
 * the tokens, but the borrower is still the beneficial owner). This
 * script combines:
 *
 *   1. On-chain token-account scan via snapshotMagpieHolders()
 *      (existing function — already filters PDAs/pools/CEX accounts)
 *   2. Active-loan collateral lookup from the loans table — the borrower
 *      wallet gets credited their collateral_amount for the snapshot
 *
 * Output:
 *   - Pretty-printed summary to stdout (counts, total balance, top 10)
 *   - JSON file at /tmp/magpie-snapshot-<YYYYMMDD-HHMM>.json containing
 *     every entry with full balance breakdown (token_account_balance,
 *     active_loan_collateral, total)
 *   - Admin DM with the summary (if TELEGRAM_BOT_TOKEN + ADMIN_TELEGRAM_ID set)
 *
 * Does NOT distribute, transfer, or modify any state. Pure read.
 *
 * Run:
 *   node scripts/magpie-snapshot.js
 *   node scripts/magpie-snapshot.js --label "tuesday-1234pm-launch"
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { snapshotMagpieHolders, MAGPIE_MINT } from "../src/services/magpie-holder-rewards.js";
import { query } from "../src/db/pool.js";
import { getAdminId } from "../src/services/admin-notify.js";

const labelIdx = process.argv.indexOf("--label");
const label = labelIdx >= 0 ? process.argv[labelIdx + 1] : null;

console.log(`📸 $MAGPIE holder snapshot — ${new Date().toISOString()}`);
console.log(`   mint: ${MAGPIE_MINT.toBase58()}`);
console.log("");

// 1. On-chain wallet holders
console.log("[1/3] Enumerating on-chain $MAGPIE token accounts...");
const onChainHolders = await snapshotMagpieHolders();
console.log(`      ${onChainHolders.length} unique wallet owners with >= 1 raw unit`);

// 2. Active-loan borrowers whose collateral is $MAGPIE
console.log("[2/3] Enumerating active-loan $MAGPIE collateral...");
const { rows: loanRows } = await query(
  `SELECT l.id, l.collateral_amount, w.public_key AS borrower_wallet
     FROM loans l
     JOIN wallets w ON w.user_id = l.user_id AND w.is_active = TRUE
    WHERE l.status = 'active'
      AND l.collateral_mint = $1`,
  [MAGPIE_MINT.toBase58()],
);
console.log(`      ${loanRows.length} active loans with $MAGPIE collateral`);

// 3. Combine — same borrower may have BOTH a wallet balance AND an active loan
console.log("[3/3] Combining holder sets...");
const combined = new Map();
for (const h of onChainHolders) {
  combined.set(h.owner, {
    owner: h.owner,
    token_account_balance_raw: BigInt(h.balance_raw).toString(),
    active_loan_collateral_raw: "0",
  });
}
for (const l of loanRows) {
  const wallet = l.borrower_wallet;
  if (!wallet) continue;
  const existing = combined.get(wallet) || {
    owner: wallet,
    token_account_balance_raw: "0",
    active_loan_collateral_raw: "0",
  };
  const prev = BigInt(existing.active_loan_collateral_raw);
  existing.active_loan_collateral_raw = (prev + BigInt(String(l.collateral_amount))).toString();
  combined.set(wallet, existing);
}

// Compute totals + sort
const entries = Array.from(combined.values()).map((e) => {
  const total = BigInt(e.token_account_balance_raw) + BigInt(e.active_loan_collateral_raw);
  return {
    owner: e.owner,
    token_account_balance_raw: e.token_account_balance_raw,
    active_loan_collateral_raw: e.active_loan_collateral_raw,
    total_raw: total.toString(),
  };
});
entries.sort((a, b) => (BigInt(b.total_raw) > BigInt(a.total_raw) ? 1 : -1));

const totalRaw = entries.reduce((acc, e) => acc + BigInt(e.total_raw), 0n);
const totalMagpie = Number(totalRaw) / 1e6; // 6 decimals
const withLoans = entries.filter((e) => BigInt(e.active_loan_collateral_raw) > 0n).length;

console.log("");
console.log("─── SUMMARY ──────────────────────────────────────────────");
console.log(`Unique holders (incl. borrowers): ${entries.length}`);
console.log(`Of those with $MAGPIE in active loan: ${withLoans}`);
console.log(`Total $MAGPIE represented: ${totalMagpie.toLocaleString(undefined, { maximumFractionDigits: 6 })}`);
console.log("");
console.log("Top 10 holders (combined balance):");
for (let i = 0; i < Math.min(10, entries.length); i++) {
  const e = entries[i];
  const t = Number(BigInt(e.total_raw)) / 1e6;
  const lo = Number(BigInt(e.active_loan_collateral_raw)) / 1e6;
  const wb = Number(BigInt(e.token_account_balance_raw)) / 1e6;
  console.log(
    `  ${String(i + 1).padStart(2)}. ${e.owner}  total ${t.toFixed(2)}  (wallet ${wb.toFixed(2)} + loan ${lo.toFixed(2)})`,
  );
}
console.log("──────────────────────────────────────────────────────────");

// Write JSON output
const ts = new Date().toISOString().replace(/[:.]/g, "").slice(0, 13);
const outPath = `/tmp/magpie-snapshot-${ts}${label ? `-${label}` : ""}.json`;
const payload = {
  taken_at: new Date().toISOString(),
  label: label ?? null,
  mint: MAGPIE_MINT.toBase58(),
  decimals: 6,
  summary: {
    unique_holders: entries.length,
    holders_with_active_loans: withLoans,
    total_magpie_represented_raw: totalRaw.toString(),
    total_magpie_represented: totalMagpie,
  },
  entries,
};
writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(`\n✓ JSON written: ${outPath}`);

// DM admin
const adminId = getAdminId();
const token = process.env.TELEGRAM_BOT_TOKEN;
if (adminId && token) {
  const top5 = entries.slice(0, 5).map((e, i) => {
    const t = Number(BigInt(e.total_raw)) / 1e6;
    return `  ${i + 1}. \`${e.owner.slice(0, 8)}…${e.owner.slice(-4)}\` — ${t.toFixed(2)}`;
  }).join("\n");
  const body = [
    "📸 *$MAGPIE holder snapshot complete*",
    "",
    `Taken: ${new Date().toISOString()}`,
    label ? `Label: \`${label}\`` : null,
    "",
    `Unique holders: *${entries.length}*`,
    `Holders with active $MAGPIE loans: *${withLoans}*`,
    `Total $MAGPIE represented: *${totalMagpie.toLocaleString(undefined, { maximumFractionDigits: 2 })}*`,
    "",
    "*Top 5:*",
    top5,
    "",
    `Full data: \`${outPath}\``,
    "",
    "_No distribution attempted. Awaiting your call on allocation + exclusions._",
  ].filter(Boolean).join("\n");
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: adminId,
        text: body,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    const data = await resp.json();
    if (data.ok) console.log("\n✓ Admin DM sent");
    else console.warn("\n⚠ Admin DM failed:", JSON.stringify(data));
  } catch (e) {
    console.warn("\n⚠ Admin DM error:", e.message);
  }
} else {
  console.log("\n(No admin DM — TELEGRAM_BOT_TOKEN or ADMIN_TELEGRAM_ID missing)");
}

process.exit(0);
