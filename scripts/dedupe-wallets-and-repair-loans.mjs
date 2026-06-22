/**
 * One-off: de-dupe the wallets table + repair the 4 mis-attributed
 * active loans. Operator-authorized 2026-06-19 PM after the loan-867
 * incident.
 *
 * Strategy for each duplicate group (same public_key, multiple user_id):
 *   - PREFER the row whose user_id ties to a real TG user (non-synthetic
 *     telegram_username NOT LIKE 'site_%' and telegram_id > 0).
 *   - FALLBACK: highest user_id (most recent link).
 *   - Re-attribute every loan referencing the kept user.
 *   - DELETE the synthetic wallet row.
 *   - INSERT audit row for every loan re-attribution.
 *
 * Idempotent — re-run is a no-op once duplicates are cleared.
 *
 * Run AFTER migration 080 is applied (table created) but BEFORE the
 * UNIQUE index, OR before applying the migration entirely (the dedupe
 * unlocks the constraint creation).
 *
 *   node scripts/dedupe-wallets-and-repair-loans.mjs
 */
import "dotenv/config";
import { query } from "../src/db/pool.js";

function pickKeeperRow(rows, users) {
  // Sort: real TG user (non-synthetic, positive telegram_id) first,
  // then highest user_id (most recent).
  const userMap = new Map(users.map((u) => [u.id, u]));
  return rows
    .map((r) => ({ ...r, _user: userMap.get(r.user_id) }))
    .sort((a, b) => {
      const aReal = a._user && !String(a._user.telegram_username || "").startsWith("site_") && a._user.telegram_id > 0;
      const bReal = b._user && !String(b._user.telegram_username || "").startsWith("site_") && b._user.telegram_id > 0;
      if (aReal && !bReal) return -1;
      if (bReal && !aReal) return 1;
      return b.user_id - a.user_id;
    })[0];
}

await query("BEGIN");
try {
  // 1. Find duplicate groups
  const dups = await query(
    `SELECT public_key, ARRAY_AGG(id::text) AS ids, ARRAY_AGG(user_id::text) AS user_ids, COUNT(*)::int AS n
       FROM wallets
      WHERE public_key IS NOT NULL
      GROUP BY public_key
     HAVING COUNT(*) > 1`,
  );
  console.log(`Duplicate wallet groups: ${dups.rowCount}`);

  let walletsDeleted = 0;
  let loansRepaired = 0;

  for (const dup of dups.rows) {
    const rows = await query(
      `SELECT id, user_id::int FROM wallets WHERE public_key = $1 ORDER BY id`,
      [dup.public_key],
    );
    const uids = rows.rows.map((r) => r.user_id);
    const users = (await query(
      `SELECT id, telegram_id, telegram_username FROM users WHERE id = ANY($1::bigint[])`,
      [uids],
    )).rows;
    const keeper = pickKeeperRow(rows.rows, users);
    console.log(
      `  public_key=${dup.public_key.slice(0, 12)}... rows=[${rows.rows.map((r) => r.id).join(",")}] user_ids=[${uids.join(",")}] keeper=wallet#${keeper.id}(user=${keeper.user_id}, ${keeper._user?.telegram_username || "?"})`,
    );

    // Re-attribute every loan referencing a doomed wallet's user to the keeper's user
    for (const row of rows.rows) {
      if (row.id === keeper.id) continue;
      const loans = await query(
        `SELECT id FROM loans WHERE borrower_wallet = $1 AND user_id = $2`,
        [dup.public_key, row.user_id],
      );
      for (const l of loans.rows) {
        await query(
          `INSERT INTO loan_user_attribution_audit (loan_id, prev_user_id, new_user_id, reason, repaired_by, metadata)
           VALUES ($1, $2, $3, 'dedupe_wallets_2026_06_19', 'one-off-script',
                   jsonb_build_object('borrower_wallet', $4::text,
                                      'doomed_wallet_row_id', $5::bigint,
                                      'keeper_wallet_row_id', $6::bigint))`,
          [l.id, row.user_id, keeper.user_id, dup.public_key, row.id, keeper.id],
        );
        await query(
          `UPDATE loans SET user_id = $1, updated_at = NOW() WHERE id = $2`,
          [keeper.user_id, l.id],
        );
        loansRepaired++;
        console.log(`    loan#${l.id} user_id ${row.user_id} -> ${keeper.user_id}`);
      }
      await query(`DELETE FROM wallets WHERE id = $1`, [row.id]);
      walletsDeleted++;
    }
  }

  await query("COMMIT");
  console.log(
    `\nSUMMARY: ${dups.rowCount} duplicate groups; ${walletsDeleted} wallet rows deleted; ${loansRepaired} loans re-attributed.`,
  );

  // Verify post-state
  const remaining = await query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT public_key FROM wallets WHERE public_key IS NOT NULL GROUP BY public_key HAVING COUNT(*) > 1
     ) t`,
  );
  console.log(`Post-dedupe duplicate groups: ${remaining.rows[0].n} (should be 0)`);

  const mismatched = await query(
    `SELECT COUNT(*)::int AS n
       FROM loans l JOIN wallets w ON w.public_key = l.borrower_wallet
      WHERE l.user_id != w.user_id AND l.status = 'active'`,
  );
  console.log(`Post-dedupe active mismatched loans: ${mismatched.rows[0].n} (should be 0)`);
} catch (e) {
  await query("ROLLBACK");
  console.error(`ROLLED BACK: ${e.message}`);
  process.exit(1);
}
process.exit(0);
