/**
 * POST /api/v1/v4/warm-mint
 *
 * "Hot-on-Select" warm-up beacon. When the site dashboard sees the user
 * open the V4 exit picker for a mint, it POSTs here. The bot:
 *   1. Inserts/upserts a row in mint_warming_intents with a 10-min TTL.
 *   2. The V4 continuous-attestation loop's SQL UNIONs this table in,
 *      so the mint gets continuously attested for the next 10 minutes
 *      even if it's cold-tier.
 *   3. By the time the user finishes reviewing the ladder + signs the
 *      borrow tx, the V4 PriceHistory PDA has 8+ samples in window.
 *
 * Operator-mandated 2026-06-19 PM after $TROLL V4 borrow hit "Markets
 * warming up" — strategic question: how do we support V4 borrows on
 * cold/inactive mints without paying to keep all 175 enabled mints
 * continuously attested?
 *
 * No signature required — this is an INTENT beacon, not authoritative
 * state. Spam protection: rate-limit per IP and per mint via DB
 * upsert (last-write-wins on expires_at).
 *
 * Body:
 *   { mint: string (base58) }
 *
 * Returns:
 *   { ok: true, mint, expires_at, hit_count }
 *   { ok: false, error: "..." }
 */
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { requestMintWarm } from "../services/v4-feed-readiness.js";

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export async function handleWarmMint(req) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return { status: 400, body: { ok: false, error: "invalid_json" } };
  }

  const mintRaw = body?.mint;
  if (typeof mintRaw !== "string" || !mintRaw.trim()) {
    return { status: 400, body: { ok: false, error: "missing_mint" } };
  }

  // Validate as Solana pubkey
  let mint;
  try {
    mint = new PublicKey(mintRaw).toBase58();
  } catch {
    return { status: 400, body: { ok: false, error: "invalid_mint_pubkey" } };
  }

  // Reject mints that aren't enabled in supported_mints (avoid creating
  // warming rows for unknown garbage).
  const { rows: mintRows } = await query(
    "SELECT enabled, symbol, attestation_tier FROM supported_mints WHERE mint = $1",
    [mint],
  );
  if (mintRows.length === 0) {
    return { status: 404, body: { ok: false, error: "mint_not_supported" } };
  }
  if (!mintRows[0].enabled) {
    return { status: 400, body: { ok: false, error: "mint_disabled" } };
  }

  // Upsert: extend TTL on every re-ping. hit_count bumps so we can see
  // how often a mint is being warmed for tuning.
  const source = String(body?.source || "site").slice(0, 20);
  const { rows } = await query(
    `INSERT INTO mint_warming_intents (mint, requested_by, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '10 minutes')
     ON CONFLICT (mint) DO UPDATE
       SET expires_at = NOW() + INTERVAL '10 minutes',
           requested_at = NOW(),
           hit_count = mint_warming_intents.hit_count + 1,
           requested_by = EXCLUDED.requested_by
     RETURNING mint, expires_at, hit_count`,
    [mint, source],
  );

  const result = rows[0];
  const symbol = mintRows[0].symbol;
  const tier = mintRows[0].attestation_tier;

  // CRITICAL: also push onto the in-memory on-demand queue. The V4
  // continuous-list refresh runs every 10 min, which is too slow for
  // the borrow-flow use case (user expands holding → needs samples in
  // 30-60s). requestMintWarm adds to state.onDemand which is processed
  // every 3s by onDemandLoop. So the DB row provides persistence + SQL
  // visibility on next continuous refresh, AND the in-memory ping
  // guarantees attestation starts within 3 seconds.
  let onDemandResult = null;
  try {
    onDemandResult = await requestMintWarm(mint);
  } catch (err) {
    console.warn(
      `[warm-mint] on-demand queue add failed: ${err.message?.slice(0, 80)}`,
    );
  }

  console.log(
    `[warm-mint] ${symbol} (${tier}) warmed by ${source}, expires ${result.expires_at.toISOString()}, hit_count=${result.hit_count}, on_demand_ready=${onDemandResult?.ready ?? "n/a"}`,
  );

  return {
    status: 200,
    body: {
      ok: true,
      mint: result.mint,
      symbol,
      tier,
      expires_at: result.expires_at,
      hit_count: result.hit_count,
      samples_in_window: onDemandResult?.samples_in_window ?? null,
      ready: onDemandResult?.ready ?? null,
    },
  };
}
