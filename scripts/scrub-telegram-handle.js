/**
 * One-off operator script — scrub a Telegram username from a user record.
 *
 * Use case: a user wants to disassociate their TG handle from their
 * Magpie account (e.g. they linked once with TG but now want full
 * site-native privacy). This NULLs the telegram_username on their
 * users row so:
 *   - It never appears in any API response
 *   - It can't be reverse-looked-up by anyone with their wallet pubkey
 *   - Their wallet bonds + loan history + credit score are all PRESERVED
 *
 * The telegram_id is left intact so the user can still receive bot
 * DMs if they want (e.g. emergency lock alerts). If you want to break
 * the bond completely, set USER_BREAK_BOND=1 and the script will also
 * NULL the telegram_id (warning: that user can no longer use TG at all).
 *
 * Usage:
 *   railway run node scripts/scrub-telegram-handle.js --handle REDACTED
 *
 * Add --execute to actually run; without it, dry-run only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });
const { query } = await import("../src/db/pool.js");

const args = process.argv.slice(2);
const handleArgIdx = args.indexOf("--handle");
const handle = handleArgIdx >= 0 ? args[handleArgIdx + 1] : null;
const execute = args.includes("--execute");
const breakBond = process.env.USER_BREAK_BOND === "1";

if (!handle) {
  console.error("Usage: node scripts/scrub-telegram-handle.js --handle <username> [--execute]");
  console.error("");
  console.error("Without --execute the script only prints what WOULD change (dry run).");
  console.error("Pass USER_BREAK_BOND=1 env to ALSO clear telegram_id (severs TG entirely).");
  process.exit(1);
}

const stripped = handle.replace(/^@/, "");

const { rows: hits } = await query(
  `SELECT id, telegram_id, telegram_username, created_at
     FROM users
    WHERE telegram_username = $1`,
  [stripped],
);

if (hits.length === 0) {
  console.log(`No users found with telegram_username='${stripped}'. Nothing to do.`);
  process.exit(0);
}

console.log(`Found ${hits.length} user(s) matching @${stripped}:`);
for (const u of hits) {
  console.log(`  id=${u.id} telegram_id=${u.telegram_id} created_at=${u.created_at}`);
}

const updateSql = breakBond
  ? `UPDATE users SET telegram_username = NULL, telegram_id = NULL WHERE telegram_username = $1`
  : `UPDATE users SET telegram_username = NULL WHERE telegram_username = $1`;

if (!execute) {
  console.log("");
  console.log("DRY RUN — would execute:");
  console.log(`  ${updateSql}  with $1 = '${stripped}'`);
  if (breakBond) console.log("  (USER_BREAK_BOND=1 → telegram_id also cleared)");
  console.log("");
  console.log("Re-run with --execute to actually apply.");
  process.exit(0);
}

const { rowCount } = await query(updateSql, [stripped]);
console.log(`Updated ${rowCount} user row(s). Telegram handle scrubbed.`);
if (breakBond) console.log("telegram_id also cleared — these users can no longer use the TG bot.");
process.exit(0);
