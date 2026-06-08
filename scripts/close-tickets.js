#!/usr/bin/env node
/**
 * Bulk-close tickets with an audit note. Used for cases like:
 *   - User blocked the bot (we can't follow up, no point in keeping it open)
 *   - Tickets the user implicitly resolved by going quiet
 *   - Operator cleanup
 *
 * Adds a closure note to admin_reply (appended, original preserved)
 * and sets status='closed' + closed_at=NOW(). Does NOT DM the user
 * (they're closed-out unilaterally — appropriate for the bot-blocked
 * case; not appropriate for general use, so use --reason explicitly).
 *
 * Usage:
 *   node scripts/close-tickets.js <id1,id2,...> --reason "<text>"
 *   node scripts/close-tickets.js <id1,id2,...> --reason "<text>" --dry-run
 */
import "dotenv/config";
import { query } from "../src/db/pool.js";

const dryRun = process.argv.includes("--dry-run");
const reasonIdx = process.argv.indexOf("--reason");
const reason = reasonIdx >= 0 ? process.argv[reasonIdx + 1] : null;
if (!reason) {
  console.error("Missing --reason \"<text>\"");
  process.exit(1);
}
const idArg = process.argv.find((a) => /^[\d,]+$/.test(a) && a.includes(","))
  || process.argv[2];
if (!idArg || !/^[\d,]+$/.test(idArg)) {
  console.error("Usage: node scripts/close-tickets.js <id1,id2,...> --reason \"<text>\" [--dry-run]");
  process.exit(1);
}
const ticketIds = idArg.split(",").map((s) => Number(s.trim())).filter(Boolean);
console.log(`${dryRun ? "DRY-RUN " : ""}closing ${ticketIds.length} ticket(s): ${ticketIds.join(", ")}`);
console.log(`Reason: ${reason}`);
console.log("");

let closed = 0;
let skipped = 0;
for (const id of ticketIds) {
  const { rows } = await query(
    `SELECT id, status FROM support_tickets WHERE id = $1`,
    [id],
  );
  const t = rows[0];
  if (!t) {
    console.log(`  #${id}: not found, skipping`);
    skipped++;
    continue;
  }
  if (t.status === "closed") {
    console.log(`  #${id}: already closed, skipping`);
    skipped++;
    continue;
  }
  if (dryRun) {
    console.log(`  #${id}: WOULD CLOSE (was: ${t.status})`);
    continue;
  }
  await query(
    `UPDATE support_tickets
        SET status = 'closed',
            closed_at = NOW(),
            admin_reply = COALESCE(admin_reply || E'\n\n', '') || '[auto-closed ' || to_char(NOW(), 'YYYY-MM-DD HH24:MI') || '] ' || $2
      WHERE id = $1`,
    [id, reason],
  );
  console.log(`  #${id}: ✓ closed (was: ${t.status})`);
  closed++;
}
console.log("");
console.log(`Closed: ${closed} · Skipped: ${skipped}`);
process.exit(0);
