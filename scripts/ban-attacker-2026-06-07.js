#!/usr/bin/env node
/**
 * One-shot ban script for the 2026-06-07 $FATHER oracle-manipulation
 * attacker.
 *
 *   Attack: bought up $FATHER with 50 + 20 SOL purchases on a thin
 *   liquidity pool to pump the price, opened back-to-back loans against
 *   the now-overvalued collateral, dumped the token. Walked away with
 *   2.64 SOL while collateral became worthless.
 *
 *   User:    11633 (telegram_id 6877998402, handle: @PamLaura)
 *   Wallets: 7FVwN8yV1pTfjW2NBpHtqfW56FdrM6QZ7cwuRdLDsUtZ
 *            3uD3gScLowDvHJVeNLDHfuHAPPUC4fz2nsBGVs1PepAS
 *
 * Run:
 *   railway run node scripts/ban-attacker-2026-06-07.js           # dry run
 *   railway run node scripts/ban-attacker-2026-06-07.js --execute # ACTUALLY ban
 *
 * Idempotent — safe to re-run; ON CONFLICT updates the row.
 */
import "dotenv/config";
import { query } from "../src/db/pool.js";
import { banUser, banWallet } from "../src/services/bans.js";

const execute = process.argv.includes("--execute");

const USER_ID = 11633;
const TELEGRAM_ID = 6877998402;
const WALLETS = [
  "7FVwN8yV1pTfjW2NBpHtqfW56FdrM6QZ7cwuRdLDsUtZ",
  "3uD3gScLowDvHJVeNLDHfuHAPPUC4fz2nsBGVs1PepAS",
];
const REASON = "$FATHER oracle-manipulation attack 2026-06-07 — pumped thin-liquidity collateral, took back-to-back loans, dumped";

console.log("─".repeat(60));
console.log(`Mode: ${execute ? "EXECUTE" : "DRY-RUN (no --execute)"}`);
console.log("─".repeat(60));

// 1. Confirm the user exists.
const { rows: userRows } = await query(
  `SELECT id, telegram_id, telegram_username, created_at
     FROM users WHERE id = $1 OR telegram_id = $2`,
  [USER_ID, TELEGRAM_ID],
);
if (!userRows.length) {
  console.error(`No user row matching id=${USER_ID} or telegram_id=${TELEGRAM_ID}`);
  process.exit(1);
}
const u = userRows[0];
console.log(`User:      #${u.id} @${u.telegram_username ?? "?"} (tg ${u.telegram_id}) created ${u.created_at}`);

// 2. Discover any *additional* wallets attached to this user beyond the
//    two we already know about. ban_sweep semantics.
const { rows: extraRows } = await query(
  `SELECT public_key FROM wallets WHERE user_id = $1`,
  [u.id],
);
const allWallets = new Set([...WALLETS, ...extraRows.map((r) => r.public_key)]);
console.log(`Wallets:   ${allWallets.size} total (${WALLETS.length} known + ${extraRows.length} discovered)`);
for (const w of allWallets) console.log(`             • ${w}`);

console.log("");
if (!execute) {
  console.log("DRY-RUN complete. Re-run with --execute to apply.");
  process.exit(0);
}

// 3. Ban the user.
await banUser({
  userId: u.id,
  telegramId: u.telegram_id,
  reason: REASON,
  bannedBy: "operator-script",
  notes: `automated script ban-attacker-2026-06-07; ${allWallets.size} wallets also banned`,
});
console.log(`✅ Banned user #${u.id}`);

// 4. Ban every wallet.
for (const pubkey of allWallets) {
  await banWallet({
    pubkey,
    reason: REASON,
    bannedBy: "operator-script",
    relatedUserId: u.id,
    notes: "ban-attacker-2026-06-07",
  });
  console.log(`✅ Banned wallet ${pubkey}`);
}

console.log("");
console.log("─".repeat(60));
console.log("Ban applied. Verify with: /ban_list in TG.");
console.log("─".repeat(60));
process.exit(0);
