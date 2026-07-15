/**
 * POST /api/v1/v4/warm-mints  (BATCH pre-warm)
 *
 * "Just-Ahead Warming" — the earliest-intent beacon. When the dashboard
 * loads a user's borrowable holdings, it POSTs the whole set here in ONE
 * call. Each mint is upserted into mint_warming_intents (10-min TTL) and
 * pushed onto the in-memory on-demand + burst queues, so their V4
 * PriceHistory PDAs fill with TWAP samples WHILE the user is still
 * picking a token / entering an amount / reading the LTV. By the time
 * they click Borrow, the feed is already warm → first-attempt success
 * with zero perceived wait, and we only pay to warm the tokens THIS user
 * actually holds (auto-expiring), never all ~175 enabled mints.
 *
 * This is the batch sibling of POST /api/v1/v4/warm-mint (single-mint,
 * fired on row-expand). Same auth model: no signature — a pure intent
 * beacon, validated against supported_mints, rate-limited per IP.
 *
 * See [[feedback_first_attempt_loan_success_cost_effective]].
 *
 * Body:
 *   { mints: string[] (base58), source?: string }
 *
 * Returns:
 *   { ok: true, requested, warming, already_warm, results: [{mint, symbol, ready, samples_in_window, eta_seconds}] }
 *   { ok: false, error: "..." }
 */
import { PublicKey } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { requestMintWarm } from "../services/v4-feed-readiness.js";

// Cap the batch so a caller can't force a huge fan-out of attestations.
// A user's borrowable holdings list is realistically < 25 mints.
const MAX_BATCH = Number(process.env.WARM_MINTS_BATCH_MAX) || 30;

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

export async function handleWarmMintsBatch(req) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return { status: 400, body: { ok: false, error: "invalid_json" } };
  }

  const rawList = Array.isArray(body?.mints) ? body.mints : null;
  if (!rawList || rawList.length === 0) {
    return { status: 400, body: { ok: false, error: "missing_mints" } };
  }

  // Normalize + dedupe + validate as base58 pubkeys. Silently drop
  // invalid entries rather than 400 the whole batch — a single bad mint
  // shouldn't sink the pre-warm of the user's other holdings.
  const seen = new Set();
  const valid = [];
  for (const m of rawList) {
    if (typeof m !== "string" || !m.trim()) continue;
    let mint;
    try {
      mint = new PublicKey(m).toBase58();
    } catch {
      continue;
    }
    if (seen.has(mint)) continue;
    seen.add(mint);
    valid.push(mint);
    if (valid.length >= MAX_BATCH) break;
  }
  if (valid.length === 0) {
    return { status: 400, body: { ok: false, error: "no_valid_mints" } };
  }

  // Keep only enabled, supported mints (one query for the whole batch).
  const { rows: supported } = await query(
    "SELECT mint, symbol FROM supported_mints WHERE mint = ANY($1::text[]) AND enabled = TRUE",
    [valid],
  );
  const symbolByMint = new Map(supported.map((r) => [r.mint, r.symbol]));
  const enabledMints = supported.map((r) => r.mint);
  if (enabledMints.length === 0) {
    return { status: 200, body: { ok: true, requested: valid.length, warming: 0, already_warm: 0, results: [] } };
  }

  const source = String(body?.source || "site-batch").slice(0, 20);

  // Persist intents in one multi-row upsert (10-min TTL, last-write-wins).
  const values = enabledMints.map((_, i) => `($${i + 1}, $${enabledMints.length + 1}, NOW() + INTERVAL '10 minutes')`).join(", ");
  await query(
    `INSERT INTO mint_warming_intents (mint, requested_by, expires_at)
       VALUES ${values}
     ON CONFLICT (mint) DO UPDATE
       SET expires_at = NOW() + INTERVAL '10 minutes',
           requested_at = NOW(),
           hit_count = mint_warming_intents.hit_count + 1,
           requested_by = EXCLUDED.requested_by`,
    [...enabledMints, source],
  );

  // Push each onto the in-memory on-demand + burst queues (attestation
  // starts within ~1.5s). Run concurrently — each requestMintWarm does a
  // cheap on-chain readiness read.
  const results = await Promise.all(
    enabledMints.map(async (mint) => {
      let r = null;
      try {
        r = await requestMintWarm(mint);
      } catch (err) {
        console.warn(`[warm-mints] on-demand add failed for ${mint.slice(0, 8)}: ${err.message?.slice(0, 80)}`);
      }
      return {
        mint,
        symbol: symbolByMint.get(mint) || null,
        ready: r?.ready ?? null,
        samples_in_window: r?.samples_in_window ?? null,
        eta_seconds: r?.eta_seconds ?? null,
      };
    }),
  );

  const alreadyWarm = results.filter((r) => r.ready === true).length;
  const warming = results.length - alreadyWarm;
  console.log(`[warm-mints] pre-warm from ${source}: ${results.length} mints (${alreadyWarm} already warm, ${warming} warming)`);

  return {
    status: 200,
    body: {
      ok: true,
      requested: valid.length,
      warming,
      already_warm: alreadyWarm,
      results,
    },
  };
}
