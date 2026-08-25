/**
 * The Hoard — Phase 1 SHADOW compute (spec: github.com/magpiecapital/hoard).
 *
 * Replays SPEC §3 streak rules over the full snapshot history and maintains
 * hoard_streaks. SHADOW ONLY: this service never touches allocations,
 * payouts, or pools — it computes what Hoard weighting WOULD do and logs the
 * aggregate, so the design can be validated on real cycles before the
 * operator-gated Phase-3 activation.
 *
 * Runs: 30s after boot, then every 6h (streak days only move with new
 * snapshots, so this is cheap idempotent replay — deterministic per SPEC §6).
 */
import { query } from "../db/pool.js";

const TIER_DAYS = [0, 14, 30, 90];
const TIER_BPS = [10000, 12500, 15000, 20000];
const DUST = 0.005; // SPEC §3.3

export function hoardMultiplierBps(streakDays) {
  let bps = TIER_BPS[0];
  for (let i = 0; i < TIER_DAYS.length; i++) if (streakDays >= TIER_DAYS[i]) bps = TIER_BPS[i];
  return bps;
}

export async function replayHoardStreaks() {
  const dists = (await query(`SELECT id, snapshot_at FROM magpie_holder_distributions ORDER BY id`)).rows;
  if (!dists.length) return { wallets: 0 };
  const state = new Map();
  for (const d of dists) {
    const rows = (await query(
      `SELECT wallet_address, balance_at_snapshot::numeric AS bal FROM magpie_holder_rewards WHERE distribution_id = $1`,
      [d.id],
    )).rows;
    const seen = new Set(rows.map((r) => r.wallet_address));
    for (const w of [...state.keys()]) if (!seen.has(w)) state.delete(w); // §3.4 absence
    for (const r of rows) {
      const bal = Number(r.bal);
      if (bal <= 0) { state.delete(r.wallet_address); continue; }
      const st = state.get(r.wallet_address);
      if (!st) { state.set(r.wallet_address, { anchorId: d.id, anchor: d.snapshot_at, lastBal: bal }); continue; }
      if (bal < st.lastBal * (1 - DUST)) state.set(r.wallet_address, { anchorId: d.id, anchor: d.snapshot_at, lastBal: bal }); // §3.3 reset
      else st.lastBal = bal; // §3.2 continue
    }
  }
  const last = dists[dists.length - 1].snapshot_at;
  // full-table refresh in one transaction (derived state, rebuild-don't-mutate)
  const values = [];
  for (const [w, st] of state) {
    const days = Math.floor((last - st.anchor) / 86400000);
    values.push({ w, anchorId: st.anchorId, anchor: st.anchor, bal: st.lastBal, days, bps: hoardMultiplierBps(days) });
  }
  await query("BEGIN");
  try {
    await query("DELETE FROM hoard_streaks");
    for (const v of values) {
      await query(
        `INSERT INTO hoard_streaks (wallet_address, anchor_snapshot_id, anchor_at, last_balance, streak_days, multiplier_bps, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
        [v.w, v.anchorId, v.anchor, v.bal, v.days, v.bps],
      );
    }
    await query("COMMIT");
  } catch (e) { await query("ROLLBACK"); throw e; }
  const tiers = [0, 0, 0, 0];
  for (const v of values) tiers[TIER_BPS.indexOf(v.bps)]++;
  console.log(`[hoard-shadow] replayed ${values.length} wallets — tiers 1.0x/1.25x/1.5x/2.0x: ${tiers.join("/")}`);
  return { wallets: values.length, tiers };
}

export function startHoardShadow() {
  if (process.env.HOARD_SHADOW_DISABLED === "true") { console.log("[hoard-shadow] disabled"); return; }
  const run = () => replayHoardStreaks().catch((e) => console.warn("[hoard-shadow] replay err:", e.message?.slice(0, 120)));
  setTimeout(run, 30_000);
  setInterval(run, 6 * 60 * 60 * 1000);
}
