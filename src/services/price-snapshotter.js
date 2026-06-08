/**
 * Periodic price + liquidity snapshotter for off-chain TWAP.
 *
 * Captures DEXScreener live state for every actively-borrowable mint
 * and writes it to mint_price_snapshots. The borrow flow consults the
 * trailing N-minute window of this table to detect price-impact
 * attacks (spot price significantly higher than the moving average).
 *
 * Why off-chain: a proper on-chain TWAP requires a contract change.
 * That's higher-stakes work (parallel program deployment). The
 * off-chain TWAP-at-cosign approach blunts the same attack class —
 * if the attacker pumps the pool, the off-chain price-impact gate
 * refuses the borrow before the on-chain ix is even built.
 *
 * Snapshot cadence: every 2 minutes. With a 30-min trailing window
 * that's ~15 samples per decision — enough signal, low cost. Auto-
 * prunes data older than 24h so the table stays small.
 */
import { query } from "../db/pool.js";

const SNAPSHOT_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.PRICE_SNAPSHOT_INTERVAL_MS) || 120_000,
);
const PRUNE_AFTER_HOURS = Math.max(
  1,
  Number(process.env.PRICE_SNAPSHOT_PRUNE_HOURS) || 24,
);
const MAX_MINTS_PER_TICK = Math.max(
  1,
  Number(process.env.PRICE_SNAPSHOT_MAX_MINTS_PER_TICK) || 50,
);

const DISABLED = process.env.PRICE_SNAPSHOTTER_DISABLED === "true";

async function fetchMintsToSnapshot() {
  // Snapshot enabled non-RWA mints. RWAs track real-world prices
  // (xStocks, etc.) and don't share the pump-and-borrow attack model
  // — their oracle is the underlying market, not a Solana DEX.
  const { rows } = await query(
    `SELECT mint FROM supported_mints
      WHERE enabled = TRUE
        AND COALESCE(category, 'memecoin') NOT IN ('stock', 'metal', 'etf')
      ORDER BY mint
      LIMIT $1`,
    [MAX_MINTS_PER_TICK],
  );
  return rows.map((r) => r.mint);
}

/**
 * DexScreener batches up to 30 mints per request via the
 * /tokens/v1/solana/<csv> path.
 */
async function fetchMarketBatch(mints) {
  const out = new Map();
  const chunkSize = 30;
  for (let i = 0; i < mints.length; i += chunkSize) {
    const chunk = mints.slice(i, i + chunkSize);
    try {
      const res = await fetch(
        `https://api.dexscreener.com/tokens/v1/solana/${chunk.join(",")}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) continue;
      const body = await res.json();
      const pairs = Array.isArray(body) ? body : [];
      // For each mint, take the deepest pool's price + liquidity.
      const best = new Map();
      for (const p of pairs) {
        const addr = p?.baseToken?.address;
        if (!addr) continue;
        const liq = Number(p?.liquidity?.usd) || 0;
        const price = Number(p?.priceUsd) || 0;
        const prev = best.get(addr);
        if (!prev || liq > prev.liquidityUsd) {
          best.set(addr, { priceUsd: price, liquidityUsd: liq });
        }
      }
      for (const [m, v] of best.entries()) out.set(m, v);
    } catch (err) {
      console.warn("[price-snapshotter] chunk fetch failed:", err.message);
    }
  }
  return out;
}

async function tick() {
  if (DISABLED) return;
  let mints;
  try {
    mints = await fetchMintsToSnapshot();
  } catch (err) {
    console.error("[price-snapshotter] fetch mints failed:", err.message);
    return;
  }
  if (!mints.length) return;

  const market = await fetchMarketBatch(mints);
  if (!market.size) return;

  // Multi-row insert; ignore conflicts on (mint, snapshot_at) which
  // would only happen if the loop fired twice within the same ms.
  const rows = [];
  const params = [];
  let p = 1;
  for (const [mint, v] of market.entries()) {
    rows.push(`($${p++}, NOW(), $${p++}, $${p++})`);
    params.push(mint, v.priceUsd, v.liquidityUsd);
  }
  try {
    await query(
      `INSERT INTO mint_price_snapshots (mint, snapshot_at, price_usd, liquidity_usd)
         VALUES ${rows.join(", ")}
         ON CONFLICT (mint, snapshot_at) DO NOTHING`,
      params,
    );
  } catch (err) {
    console.warn("[price-snapshotter] insert failed:", err.message);
  }

  // Best-effort prune. Cheap when there's nothing to delete.
  try {
    await query(
      `DELETE FROM mint_price_snapshots WHERE snapshot_at < NOW() - INTERVAL '${PRUNE_AFTER_HOURS} hours'`,
    );
  } catch {
    // ignore — prune is opportunistic
  }
}

export function startPriceSnapshotter() {
  console.log(
    `📊 Price snapshotter running every ${SNAPSHOT_INTERVAL_MS / 1000}s (disabled=${DISABLED})`,
  );
  const run = () => tick().catch((err) => console.error("[price-snapshotter]", err));
  run();
  return setInterval(run, SNAPSHOT_INTERVAL_MS);
}

/**
 * Return the trailing N-minute average price + liquidity for a mint,
 * along with the most recent snapshot. Used by the borrow-time
 * price-impact check.
 *
 * Returns null if we don't have enough samples (< minSamples) to make
 * a confident decision — fail-open semantics for the caller.
 */
export async function getTrailingPriceStats(mint, windowMinutes = 30, minSamples = 5) {
  try {
    const { rows } = await query(
      `SELECT
          AVG(price_usd)::float8       AS avg_price,
          AVG(liquidity_usd)::float8   AS avg_liq,
          COUNT(*)::int                AS n,
          (SELECT price_usd FROM mint_price_snapshots
            WHERE mint = $1 ORDER BY snapshot_at DESC LIMIT 1)     AS last_price,
          (SELECT liquidity_usd FROM mint_price_snapshots
            WHERE mint = $1 ORDER BY snapshot_at DESC LIMIT 1)     AS last_liq
         FROM mint_price_snapshots
        WHERE mint = $1
          AND snapshot_at > NOW() - ($2::text || ' minutes')::interval`,
      [mint, String(windowMinutes)],
    );
    const r = rows[0];
    if (!r || Number(r.n) < minSamples) return null;
    return {
      samples: Number(r.n),
      avgPrice: Number(r.avg_price),
      avgLiquidity: Number(r.avg_liq),
      lastPrice: Number(r.last_price),
      lastLiquidity: Number(r.last_liq),
    };
  } catch (err) {
    console.warn("[price-snapshotter] getTrailingPriceStats failed:", err.message);
    return null;
  }
}
