#!/usr/bin/env node
/**
 * Backfill the `distribution_events` audit ledger from the real payout tables.
 *
 * WHY (2026-08-13). `distribution_events` is what the PUBLIC /distributions
 * audit trail reads. Two surfaces had silently diverged:
 *
 *   /api/v1/transparency        → 10 LP distributions, 2.4764 SOL   (correct)
 *   /api/v1/public/distributions → 4 LP events (lp-1, 22, 23, 24)   (wrong)
 *
 * Cause: the holder path calls upsertDistributionEvent(); the LP path never
 * did, so every LP distribution from #25 onward was missing — six cycles.
 * Fixed forward in src/services/lp-loyalty.js; this repairs the history.
 *
 * Also re-syncs holder distributions, because `unpayable_wallet_count` was
 * hardcoded to 0 there. That was harmless until dist #9, when 319 rows became
 * unpayable under the rent-exempt floor and the audit trail was left with
 * ~0.0048 SOL that reconciled to nothing (pool − distributed − unpaid ≠ 0).
 *
 * Everything is derived from lp_loyalty_* / magpie_holder_* — the tables that
 * actually recorded the payments — so this invents nothing. Idempotent:
 * upsertDistributionEvent is ON CONFLICT (kind, external_ref) DO UPDATE.
 *
 *   railway run --service magpie-bot node scripts/backfill-distribution-events.mjs
 *   railway run --service magpie-bot node scripts/backfill-distribution-events.mjs --write
 */
import { query } from "../src/db/pool.js";

const WRITE = process.argv.includes("--write");

const { syncLpLoyaltyDistributionEvent } = await import("../src/services/lp-loyalty.js");
const { syncMagpieHolderDistributionEvent } = await import(
  "../src/services/magpie-holder-rewards.js"
).catch(() => ({ syncMagpieHolderDistributionEvent: null }));

const { rows: lpDists } = await query(`SELECT id FROM lp_loyalty_distributions ORDER BY id`);
const { rows: hDists } = await query(`SELECT id FROM magpie_holder_distributions ORDER BY id`);
const { rows: haveRows } = await query(
  `SELECT kind, external_ref FROM distribution_events`,
);
const have = new Set(haveRows.map((r) => r.external_ref));

const lpMissing = lpDists.filter((d) => !have.has(`lp-${d.id}`)).map((d) => d.id);
const hMissing = hDists.filter((d) => !have.has(`holder-${d.id}`)).map((d) => d.id);

console.log(`\nLP distributions:     ${lpDists.length} · missing events: ${lpMissing.length ? lpMissing.join(", ") : "(none)"}`);
console.log(`Holder distributions: ${hDists.length} · missing events: ${hMissing.length ? hMissing.join(", ") : "(none)"}`);
console.log(`Existing events: ${have.size}`);

if (!WRITE) {
  console.log(
    `\nDRY RUN — nothing written.` +
      `\n  would CREATE ${lpMissing.length} LP + ${hMissing.length} holder event(s)` +
      `\n  would RE-SYNC all ${lpDists.length} LP + ${hDists.length} holder distributions` +
      `\n    (re-sync corrects counts on rows that already exist, e.g. holder-9's` +
      `\n     unpayable_wallet_count, and is a no-op where nothing changed)` +
      `\n\nRe-run with --write to apply.\n`,
  );
  process.exit(0);
}

let lpOk = 0, lpFail = 0, hOk = 0, hFail = 0;

for (const d of lpDists) {
  const res = await syncLpLoyaltyDistributionEvent(d.id);
  if (res === null) { lpFail++; console.error(`  ✗ lp-${d.id}`); }
  else { lpOk++; console.log(`  ✓ lp-${d.id}`); }
}

if (syncMagpieHolderDistributionEvent) {
  for (const d of hDists) {
    try {
      await syncMagpieHolderDistributionEvent(d.id);
      hOk++; console.log(`  ✓ holder-${d.id}`);
    } catch (e) { hFail++; console.error(`  ✗ holder-${d.id}: ${e.message}`); }
  }
} else {
  console.warn("  (holder sync not exported — skipping holder re-sync)");
}

console.log(`\nLP: ${lpOk} synced, ${lpFail} failed · Holder: ${hOk} synced, ${hFail} failed`);
process.exit(lpFail + hFail === 0 ? 0 : 1);
