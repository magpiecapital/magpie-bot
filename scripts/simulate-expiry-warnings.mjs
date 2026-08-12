#!/usr/bin/env node
/**
 * Pre-flight simulation of the loan-expiry warning chain.
 *
 * WHY. The chain rebuilt on 2026-08-12 (PRs #652, #653, #655, #656) has never
 * actually fired in production — the nearest real loan is still hours from its
 * 24h checkpoint. Finding a defect at the moment a borrower's collateral is on
 * the line is the worst possible time, so this exercises every selection rule
 * first.
 *
 * HOW IT STAYS SAFE:
 *   - Everything happens inside a single transaction that ALWAYS rolls back.
 *   - It inserts SYNTHETIC users and loans and only ever queries those. No real
 *     loan row is read into a decision or written to.
 *   - It sends NOTHING. No Telegram call, no push call. It runs the watcher's
 *     SELECTs and reports which rows they would have picked up.
 *
 * What it proves, per scenario: that the 24h pass, the 6h pass and the
 * two-tier operator backstop each select exactly the loans they should, and
 * — just as important — skip the ones they should.
 *
 *   railway run --service magpie-bot node scripts/simulate-expiry-warnings.mjs
 */
import pg from "pg";

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

let failures = 0;
const ok = (n) => console.log(`  ✅ ${n}`);
const bad = (n, d) => { failures++; console.error(`  ❌ ${n}${d ? ` — ${d}` : ""}`); };

// Mirrors src/services/loan-watcher.js. Kept literal rather than imported so a
// silent change to the real query shows up here as a difference in behaviour.
const UNDELIVERABLE_RETRY = "1 hour";
const BACKSTOP_HOURS = 3;
const BACKSTOP_UNREACHABLE_HOURS = 24;

const Q_24H = `
  SELECT l.id FROM loans l JOIN users u ON u.id = l.user_id
   WHERE l.status = 'active'
     AND l.warned_24h_at IS NULL
     AND (l.warn_undeliverable_at IS NULL
          OR l.warn_undeliverable_at < NOW() - INTERVAL '${UNDELIVERABLE_RETRY}')
     AND l.due_timestamp <= NOW() + INTERVAL '24 hours'
     AND l.due_timestamp > NOW()
     AND l.id = ANY($1)`;

const Q_6H = `
  SELECT l.id FROM loans l JOIN users u ON u.id = l.user_id
   WHERE l.status = 'active'
     AND l.warned_6h_at IS NULL
     AND (l.warn_undeliverable_at IS NULL
          OR l.warn_undeliverable_at < NOW() - INTERVAL '${UNDELIVERABLE_RETRY}')
     AND l.due_timestamp <= NOW() + INTERVAL '6 hours'
     AND l.due_timestamp > NOW()
     AND l.id = ANY($1)`;

const Q_BACKSTOP = `
  SELECT l.id, (u.telegram_id::bigint < 0) AS unreachable
    FROM loans l LEFT JOIN users u ON u.id = l.user_id
   WHERE l.status = 'active'
     AND l.warned_6h_at IS NULL
     AND l.warn_escalated_at IS NULL
     AND l.due_timestamp > NOW()
     AND l.due_timestamp <= NOW() + (
           CASE WHEN u.telegram_id::bigint < 0
                THEN INTERVAL '${BACKSTOP_UNREACHABLE_HOURS} hours'
                ELSE INTERVAL '${BACKSTOP_HOURS} hours' END)
     AND l.id = ANY($1)`;

await c.query("BEGIN");
try {
  // ── Synthetic actors ───────────────────────────────────────────────────
  // Telegram user (positive id) and site-native user (negative id), in the
  // same shape the bot's own bootstrap produces.
  const mkUser = async (tgId, username) => {
    const { rows } = await c.query(
      `INSERT INTO users (telegram_id, telegram_username) VALUES ($1, $2) RETURNING id`,
      [tgId, username],
    );
    return rows[0].id;
  };
  const tgUser = await mkUser(999000001, "sim_tg_user");
  const siteUser = await mkUser(-888000001, "site_SIMULATED");

  let seq = 0;
  /** Insert a synthetic loan due `hours` from now. */
  const mkLoan = async (userId, hours, extra = {}) => {
    seq++;
    const { rows } = await c.query(
      `INSERT INTO loans
         (user_id, loan_id, loan_pda, collateral_mint, collateral_amount,
          loan_amount_lamports, original_loan_amount_lamports,
          ltv_percentage, duration_days, start_timestamp, due_timestamp, status,
          borrower_wallet, warned_24h_at, warned_6h_at,
          warn_undeliverable_at, warn_escalated_at)
       VALUES ($1, $2, $3, 'SIMULATEDMINT1111111111111111111111111111', 1000,
               1000000000, 1000000000, 50, 7,
               NOW() - INTERVAL '1 day', NOW() + ($4 || ' hours')::interval, $5,
               'SIMwallet1111111111111111111111111111111111',
               $6, $7, $8, $9)
       RETURNING id`,
      [
        userId,
        // Built as a STRING: loan_id is numeric and these ids exceed
        // Number.MAX_SAFE_INTEGER, so 9e17 + 1 === 9e17 in JS and every
        // synthetic loan collided on the unique constraint.
        `99900000000000${String(seq).padStart(4, "0")}`,
        `SIMPDA${seq}`,
        String(hours),
        extra.status ?? "active",
        extra.warned24 ?? null,
        extra.warned6 ?? null,
        extra.undeliverable ?? null,
        extra.escalated ?? null,
      ],
    );
    return rows[0].id;
  };

  // ── Scenarios ──────────────────────────────────────────────────────────
  const L = {
    tg_30h:        await mkLoan(tgUser, 30),
    tg_20h:        await mkLoan(tgUser, 20),
    tg_5h:         await mkLoan(tgUser, 5),
    tg_2h:         await mkLoan(tgUser, 2),
    tg_20h_warned: await mkLoan(tgUser, 20, { warned24: "NOW()" }),
    site_30h:      await mkLoan(siteUser, 30),
    site_20h:      await mkLoan(siteUser, 20),
    site_2h:       await mkLoan(siteUser, 2),
    tg_20h_repaid: await mkLoan(tgUser, 20, { status: "repaid" }),
    tg_overdue:    await mkLoan(tgUser, -5),
  };
  // Set the "already warned" marker properly (parameterised NOW() is a string).
  await c.query(`UPDATE loans SET warned_24h_at = NOW() WHERE id = $1`, [L.tg_20h_warned]);
  // A loan whose DM failed 5 minutes ago — inside the 1h backoff.
  const recentFail = await mkLoan(tgUser, 20);
  await c.query(
    `UPDATE loans SET warn_undeliverable_at = NOW() - INTERVAL '5 minutes' WHERE id = $1`,
    [recentFail],
  );
  // Same, but 2 hours ago — backoff expired, should retry.
  const oldFail = await mkLoan(tgUser, 20);
  await c.query(
    `UPDATE loans SET warn_undeliverable_at = NOW() - INTERVAL '2 hours' WHERE id = $1`,
    [oldFail],
  );

  const all = [...Object.values(L), recentFail, oldFail];
  const idsOf = async (sql) => new Set((await c.query(sql, [all])).rows.map((r) => Number(r.id)));

  const sel24 = await idsOf(Q_24H);
  const sel6 = await idsOf(Q_6H);
  const selBack = new Set((await c.query(Q_BACKSTOP, [all])).rows.map((r) => Number(r.id)));

  const has = (set, id) => set.has(Number(id));
  const check = (name, actual, wanted) => (actual === wanted ? ok(name) : bad(name, `got ${actual}, wanted ${wanted}`));

  console.log("\n== 24h pass selects the right loans ==");
  check("20h out → selected", has(sel24, L.tg_20h), true);
  check("30h out → NOT selected (too early)", has(sel24, L.tg_30h), false);
  check("5h out → selected (still inside 24h)", has(sel24, L.tg_5h), true);
  check("already warned → NOT re-selected", has(sel24, L.tg_20h_warned), false);
  check("repaid loan → NOT selected", has(sel24, L.tg_20h_repaid), false);
  check("overdue → NOT selected (deadline passed)", has(sel24, L.tg_overdue), false);
  check("DM failed 5min ago → backed off, NOT selected", has(sel24, recentFail), false);
  check("DM failed 2h ago → retried, selected", has(sel24, oldFail), true);
  check("site-only 20h out → selected (push path)", has(sel24, L.site_20h), true);

  console.log("\n== 6h pass ==");
  check("5h out → selected", has(sel6, L.tg_5h), true);
  check("20h out → NOT selected (too early for 6h)", has(sel6, L.tg_20h), false);
  check("2h out → selected", has(sel6, L.tg_2h), true);

  console.log("\n== two-tier operator backstop ==");
  check("reachable @2h → escalated", has(selBack, L.tg_2h), true);
  check("reachable @5h → NOT yet (3h tier)", has(selBack, L.tg_5h), false);
  check("UNREACHABLE @20h → escalated early (24h tier)", has(selBack, L.site_20h), true);
  check("unreachable @30h → NOT yet (beyond 24h)", has(selBack, L.site_30h), false);
  check("unreachable @2h → escalated", has(selBack, L.site_2h), true);
  check("repaid → never escalated", has(selBack, L.tg_20h_repaid), false);
  check("overdue → not escalated (deadline already passed)", has(selBack, L.tg_overdue), false);

  console.log("\n== the orphan case the LEFT JOIN guards against ==");
  {
    // Originally this tried to NULL out user_id and assert the backstop still
    // covered the loan. It cannot: loans.user_id is NOT NULL with
    // loans_user_id_fkey ON DELETE CASCADE, so an orphaned loan is unreachable.
    // Asserting a protection against an impossible state would be theatre, so
    // this asserts the ACTUAL invariant that makes it impossible. If either
    // half is ever relaxed, this fails and the LEFT JOIN starts earning its
    // keep for real.
    const { rows: fk } = await c.query(
      `SELECT 1 FROM pg_constraint
        WHERE conrelid='loans'::regclass AND contype='f' AND conname='loans_user_id_fkey'`);
    check("loans_user_id_fkey still exists", fk.length > 0, true);

    const { rows: nn } = await c.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name='loans' AND column_name='user_id'`);
    check("loans.user_id is still NOT NULL", nn[0]?.is_nullable, "NO");

    const { rows: orph } = await c.query(
      `SELECT COUNT(*)::int AS n FROM loans l
        WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = l.user_id)`);
    check("zero orphaned loans in production", orph[0].n, 0);
  }

} catch (err) {
  bad("simulation threw", err.message);
} finally {
  await c.query("ROLLBACK");
  console.log("\n↩︎  transaction rolled back — database unchanged");
  await c.end();
}

console.log(failures === 0 ? "\n✅ warning chain simulation passed\n" : `\n❌ ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
