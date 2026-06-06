#!/usr/bin/env node
/**
 * Post-deploy sanity check for the site signed endpoints + backing DB.
 *
 *   npm run check-site
 *
 * Hits the deployed bot API and verifies:
 *   1. /api/v1/health returns 200 and all background services are ok
 *   2. /api/v1/site-status returns the global enabled/disabled flag
 *   3. /api/v1/credit/leaderboard responds (newest public route)
 *   4. Every signed endpoint rejects unsigned POSTs with 400
 *   5. /api/v1/support/tickets list does NOT leak message/admin_reply
 *   6. /api/v1/wallets list does NOT leak label
 *   7. Schema patches are applied (used_nonces, site_withdrawals,
 *      site_global_state, site_lock_events, users.site_locked_until)
 *
 * Reads BOT_API_URL from env, defaulting to the magpie-bot Railway URL.
 * Reads DATABASE_URL for the schema check.
 *
 * Exits non-zero on any failure so it can be wired into CI later.
 */
import "dotenv/config";
import pg from "pg";

const BOT = (process.env.BOT_API_URL || "https://magpie-bot-production.up.railway.app").replace(/\/$/, "");
let pass = 0;
let fail = 0;

function ok(label) {
  console.log(`✓  ${label}`);
  pass++;
}
function bad(label, detail) {
  console.log(`✗  ${label}${detail ? ` — ${detail}` : ""}`);
  fail++;
}

async function check(label, fn) {
  try {
    const result = await fn();
    if (result === false) bad(label);
    else ok(label);
  } catch (e) {
    bad(label, e.message?.slice(0, 120));
  }
}

console.log(`Probing ${BOT}\n`);

// 1. health
await check("GET /api/v1/health → 200 + checks ok", async () => {
  const r = await fetch(`${BOT}/api/v1/health`);
  const j = await r.json();
  if (j.status !== "ok") throw new Error(`status=${j.status} reasons=${(j.reasons || []).join(",")}`);
  return true;
});

// 2. site-status
await check("GET /api/v1/site-status responds", async () => {
  const r = await fetch(`${BOT}/api/v1/site-status`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (typeof j.disabled !== "boolean") throw new Error("missing disabled field");
  return true;
});

// 3. leaderboard public
await check("GET /api/v1/credit/leaderboard → 200 without API key", async () => {
  const r = await fetch(`${BOT}/api/v1/credit/leaderboard`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return true;
});

// 4. signed endpoints reject unsigned POSTs
const signedEndpoints = [
  "/api/v1/withdraw",
  "/api/v1/support/ask",
  "/api/v1/support/ticket-details",
  "/api/v1/support/delete-ticket",
  "/api/v1/wallets/set-active",
  "/api/v1/prefs/set",
  "/api/v1/ai/chat",
  "/api/v1/me/export",
];
for (const ep of signedEndpoints) {
  await check(`POST ${ep} (unsigned) → 400`, async () => {
    const r = await fetch(`${BOT}${ep}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (r.status !== 400) throw new Error(`got ${r.status}`);
    return true;
  });
}

// 5. tickets list does not leak content
await check("GET /api/v1/support/tickets does NOT include message/admin_reply", async () => {
  // Use any wallet — empty result is fine, we just check the shape.
  const r = await fetch(`${BOT}/api/v1/support/tickets?wallet=4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j.tickets)) throw new Error("no tickets array");
  if (j.tickets.length === 0) return true; // can't verify shape on empty
  const t = j.tickets[0];
  if ("message" in t) throw new Error("message field present (privacy leak)");
  if ("admin_reply" in t) throw new Error("admin_reply field present (privacy leak)");
  return true;
});

// 6. wallets list does not leak label
await check("GET /api/v1/wallets does NOT include label field", async () => {
  const r = await fetch(`${BOT}/api/v1/wallets?wallet=4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j.wallets) || j.wallets.length === 0) return true;
  if ("label" in j.wallets[0]) throw new Error("label field present (privacy leak)");
  return true;
});

// 7. schema patches
if (process.env.DATABASE_URL) {
  const sql = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await sql.connect();
  const tableExists = async (name) => {
    const { rows } = await sql.query(`SELECT to_regclass($1) AS t`, [`public.${name}`]);
    return rows[0].t === name;
  };
  const colExists = async (table, col) => {
    const { rows } = await sql.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
      [table, col],
    );
    return rows.length > 0;
  };

  for (const t of ["used_nonces", "site_withdrawals", "site_global_state", "site_lock_events", "account_link_codes"]) {
    await check(`DB table ${t} exists`, async () => (await tableExists(t)) || (() => { throw new Error("missing"); })());
  }
  await check(`DB col users.site_locked_until exists`, async () => (await colExists("users", "site_locked_until")) || (() => { throw new Error("missing"); })());
  await check(`DB col support_tickets.followup_count exists`, async () => (await colExists("support_tickets", "followup_count")) || (() => { throw new Error("missing"); })());
  await sql.end();
} else {
  console.log("(skipping DB checks — DATABASE_URL not set)");
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
