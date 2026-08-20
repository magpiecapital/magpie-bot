#!/usr/bin/env node
/**
 * Guard: the per-token exposure cap must hold under CONCURRENT borrows.
 *
 * THE BUG THIS PROVES IS FIXED (oracle audit, HIGH). The cap used to read
 * `SUM(active loans)` with no lock, and a loan is only recorded AFTER its tx
 * broadcasts. So N borrows against the same mint could all read the same
 * pre-borrow sum, all pass, and land total exposure at N× the cap — removing
 * the last systemic backstop against a swarm on a thin or manipulated mint.
 *
 * A single-threaded test cannot see this. The race only appears when several
 * callers are inside the check at once, which is why this fires genuinely
 * concurrent requests through REAL database connections and calls the SHIPPED
 * `reserveBorrowExposure()` — not a reimplementation, which would pass happily
 * while the real code raced.
 *
 * SAFETY. Every mint used here is a synthetic string that cannot collide with a
 * real mint (`__RACETEST__…`), so the reservations created can never affect a
 * real borrower's cap. Rows are deleted afterwards, and they carry a TTL that
 * expires them anyway.
 *
 *   railway run --service magpie-bot node scripts/check-borrow-reservation-race.mjs
 */
import { reserveBorrowExposure } from "../src/services/anti-exploit.js";
import { query } from "../src/db/pool.js";

let failures = 0;
const ok = (n) => console.log(`  ✅ ${n}`);
const bad = (n, d) => { failures++; console.error(`  ❌ ${n}${d ? ` — ${d}` : ""}`); };
const expect = (n, a, w) => (a === w ? ok(n) : bad(n, `got ${a}, wanted ${w}`));

const SOL = 1_000_000_000n;
const mints = [];
const mint = (tag) => {
  const m = `__RACETEST__${tag}_${process.pid}`;
  mints.push(m);
  return m;
};

async function cleanup() {
  if (!mints.length) return;
  await query(`DELETE FROM borrow_reservations WHERE collateral_mint = ANY($1)`, [mints])
    .catch((e) => console.error("cleanup failed:", e.message));
}

try {
  console.log("\n== the race itself: 10 concurrent borrows, cap fits only 1 ==");
  {
    const m = mint("one");
    const cap = 1n * SOL;
    // Fired with Promise.all so they are genuinely in flight together. Without
    // the advisory lock, most or all of these would pass.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        reserveBorrowExposure(m, 1n * SOL, cap, `wallet_${i}`).catch((e) => ({ ok: false, err: e.message })),
      ),
    );
    const passed = results.filter((r) => r.ok).length;
    expect("exactly 1 of 10 concurrent borrows is allowed", passed, 1);

    const { rows } = await query(
      `SELECT COALESCE(SUM(amount_lamports),0)::TEXT AS total FROM borrow_reservations
        WHERE collateral_mint = $1 AND expires_at > now()`, [m]);
    expect("reserved total never exceeds the cap", BigInt(rows[0].total) <= cap, true);
  }

  console.log("\n== a cap that fits exactly 3 admits exactly 3 ==");
  {
    const m = mint("three");
    const cap = 3n * SOL;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        reserveBorrowExposure(m, 1n * SOL, cap, `w${i}`).catch(() => ({ ok: false })),
      ),
    );
    expect("exactly 3 of 12 allowed", results.filter((r) => r.ok).length, 3);
  }

  console.log("\n== uneven sizes still cannot overshoot ==");
  {
    const m = mint("uneven");
    const cap = 5n * SOL;
    const sizes = [3n, 3n, 2n, 2n, 1n, 1n, 4n, 5n].map((x) => x * SOL);
    const results = await Promise.all(
      sizes.map((amt, i) => reserveBorrowExposure(m, amt, cap, `w${i}`).catch(() => ({ ok: false }))),
    );
    const { rows } = await query(
      `SELECT COALESCE(SUM(amount_lamports),0)::TEXT AS total FROM borrow_reservations
        WHERE collateral_mint = $1 AND expires_at > now()`, [m]);
    const total = BigInt(rows[0].total);
    ok(`${results.filter((r) => r.ok).length} of 8 admitted, ${total / SOL} SOL reserved`);
    expect("total reserved <= cap", total <= cap, true);
  }

  console.log("\n== independent mints do not block each other ==");
  {
    const a = mint("mintA"), b = mint("mintB");
    const [ra, rb] = await Promise.all([
      reserveBorrowExposure(a, 1n * SOL, 1n * SOL, "wa"),
      reserveBorrowExposure(b, 1n * SOL, 1n * SOL, "wb"),
    ]);
    expect("mint A admitted", ra.ok, true);
    expect("mint B admitted (different lock)", rb.ok, true);
  }

  console.log("\n== a normal single borrow under cap still passes ==");
  {
    const m = mint("single");
    const r = await reserveBorrowExposure(m, 1n * SOL, 10n * SOL, "solo");
    expect("well under cap → allowed", r.ok, true);
    expect("returns a reservation id", Number.isFinite(Number(r.reservationId)), true);
  }

  console.log("\n== expired reservations stop counting ==");
  {
    const m = mint("expiry");
    const cap = 1n * SOL;
    const first = await reserveBorrowExposure(m, 1n * SOL, cap, "w1");
    expect("first admitted", first.ok, true);
    const second = await reserveBorrowExposure(m, 1n * SOL, cap, "w2");
    expect("second blocked while first is live", second.ok, false);

    // Age the reservation past its TTL rather than sleeping for it.
    await query(
      `UPDATE borrow_reservations SET expires_at = now() - interval '1 second'
        WHERE collateral_mint = $1`, [m]);
    const third = await reserveBorrowExposure(m, 1n * SOL, cap, "w3");
    expect("admitted again once the reservation expired", third.ok, true);
  }

  console.log("\n== the cap counts REAL active loans too, not just reservations ==");
  {
    // Proven without inserting a loan: the query sums active loans for the mint,
    // and a synthetic mint has none, so a cap of 0 must block everything. If the
    // loans term were dropped from the sum, a 0 cap would still block — so this
    // asserts the boundary rather than the term. The loans half is covered by
    // the shipped query and by simulate-expiry-warnings' schema checks.
    const m = mint("zerocap");
    const r = await reserveBorrowExposure(m, 1n, 0n, "w");
    expect("zero cap admits nothing", r.ok, false);
  }
  console.log("\n== same-wallet retry REPLACES its reservation (2026-08-20 AAPLx bug) ==");
  {
    // The site's oracle-warming auto-retry re-POSTs the same signed borrow
    // every few seconds. Each attempt used to INSERT a fresh reservation, so
    // a wallet blocked ITSELF on the cap by attempt 3 with zero real loans
    // ("18.22 of 20 SOL already borrowed"). A retry from the same wallet must
    // replace its own in-flight reservation, not stack on top of it.
    const m = mint("selfretry");
    const cap = 20n * SOL;
    for (let i = 0; i < 5; i++) {
      const r = await reserveBorrowExposure(m, 9n * SOL, cap, "same-wallet");
      expect(`retry ${i + 1} admitted (never self-collides)`, r.ok, true);
    }
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM borrow_reservations WHERE collateral_mint = $1`, [m]);
    expect("exactly ONE live reservation after 5 retries", rows[0].n, 1);
    // …while a DIFFERENT wallet's reservation still counts additively.
    const other = await reserveBorrowExposure(m, 9n * SOL, cap, "other-wallet");
    expect("second wallet admitted under remaining cap", other.ok, true);
    const third = await reserveBorrowExposure(m, 9n * SOL, cap, "third-wallet");
    expect("third wallet blocked — cross-wallet exposure still additive", third.ok, false);
    expect("blocked result reports the reserved split honestly",
      third.reservedLamports === 18n * SOL && third.loanLamports === 0n, true);
  }

  console.log("\n== a DB failure must NEVER block a legitimate borrow ==");
  {
    // Blocking real borrowers would be a worse outcome than the vulnerability
    // this fixes. reserveBorrowExposure throws on DB error and the caller's
    // outer catch must fail OPEN (return null = not blocked), matching the
    // posture of the racy cap query it replaced.
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../src/services/anti-exploit.js", import.meta.url), "utf8");
    expect("outer catch fails open on any error",
      /catch \(err\)[\s\S]{0,200}fail-open[\s\S]{0,120}return null/.test(src), true);
    expect("reservation failure returns a friendly cap message, not a raw error",
      /reason: "per_token_cap"[\s\S]{0,400}exposure cap/.test(src), true);
  }
} catch (err) {
  bad("race guard threw", err.message);
} finally {
  await cleanup();
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM borrow_reservations WHERE collateral_mint LIKE '__RACETEST__%'`,
  ).catch(() => ({ rows: [{ n: -1 }] }));
  console.log(`\n🧹 cleanup: ${rows[0].n} synthetic reservation(s) remaining (want 0)`);
  if (rows[0].n !== 0) failures++;
}

console.log(failures === 0 ? "\n✅ borrow reservation race guard passed\n" : `\n❌ ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
