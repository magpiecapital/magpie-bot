/**
 * One-shot: insert $BP into supported_mints with enabled=TRUE and
 * protected=TRUE.
 *
 * Operator vetted $BP 2026-06-17 PM and approved it permanently:
 *   "I want you to manually add $BP to the approved tokens list
 *    (BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy) and I want you to
 *    put it on the exempt list, so that it NEVER gets removed."
 *
 * protected=TRUE makes $BP exempt from the hourly token-health watcher's
 * auto-disable logic — same mechanism that protects $MAGPIE. See
 * src/services/token-health.js for the exclusion filter:
 *   WHERE enabled = TRUE AND (protected IS NOT TRUE)
 *
 * Idempotent: re-running just refreshes metadata and re-applies the flags.
 *
 * Usage:
 *   railway run --service=magpie-bot node scripts/add-bp-token.js
 */
import "dotenv/config";

const BP_MINT = "BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy";

async function main() {
  const { query } = await import("../src/db/pool.js");

  let symbol = "BP";
  let name = "BP";
  let decimals = 6;
  let imageUrl = null;
  let liquidityUsd = 0;
  let volume24h = 0;
  let marketCap = 0;

  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${BP_MINT}`);
    if (res.ok) {
      const pairs = await res.json();
      if (Array.isArray(pairs) && pairs.length > 0) {
        const best = pairs.reduce((b, p) =>
          (p.liquidity?.usd ?? 0) > (b.liquidity?.usd ?? 0) ? p : b,
        );
        symbol = best.baseToken?.symbol?.toUpperCase() || symbol;
        name = best.baseToken?.name || name;
        imageUrl = best.info?.imageUrl || null;
        liquidityUsd = best.liquidity?.usd ?? 0;
        volume24h = best.volume?.h24 ?? 0;
        marketCap = best.marketCap ?? best.fdv ?? 0;
      }
    }
  } catch (err) {
    console.warn("DexScreener lookup failed, using defaults:", err.message);
  }

  try {
    const { PublicKey } = await import("@solana/web3.js");
    const { connection } = await import("../src/solana/connection.js");
    const info = await connection.getAccountInfo(new PublicKey(BP_MINT));
    if (info?.data?.length >= 45) {
      decimals = info.data.readUInt8(44);
    }
  } catch (err) {
    console.warn("On-chain decimals lookup failed, using default:", err.message);
  }

  console.log(`Adding ${symbol} (${BP_MINT}):`);
  console.log(`  name: ${name}`);
  console.log(`  decimals: ${decimals}`);
  console.log(`  liquidity: $${Math.floor(liquidityUsd).toLocaleString()}`);
  console.log(`  enabled: TRUE`);
  console.log(`  protected: TRUE (exempt from auto-disqualification)`);
  console.log();

  await query(
    `INSERT INTO supported_mints
       (mint, symbol, name, decimals, category, image_url,
        liquidity_usd, holder_count, market_cap_usd,
        has_mint_authority, has_freeze_authority, lp_burned,
        token_age_hours, auto_approved, screened_at, source,
        enabled, protected)
     VALUES ($1, $2, $3, $4, 'memecoin', $5,
             $6, 0, $7,
             FALSE, FALSE, FALSE,
             0, FALSE, NOW(), 'operator_approved',
             TRUE, TRUE)
     ON CONFLICT (mint) DO UPDATE SET
       symbol = EXCLUDED.symbol,
       name = COALESCE(EXCLUDED.name, supported_mints.name),
       decimals = EXCLUDED.decimals,
       image_url = COALESCE(EXCLUDED.image_url, supported_mints.image_url),
       liquidity_usd = EXCLUDED.liquidity_usd,
       market_cap_usd = EXCLUDED.market_cap_usd,
       category = 'memecoin',
       source = 'operator_approved',
       enabled = TRUE,
       protected = TRUE`,
    [BP_MINT, symbol, name, decimals, imageUrl, liquidityUsd, marketCap],
  );

  // Mark seen so the screener doesn't re-process it
  await query(
    `INSERT INTO token_screen_seen (mint) VALUES ($1) ON CONFLICT DO NOTHING`,
    [BP_MINT],
  );

  const { rows } = await query(
    `SELECT mint, symbol, category, enabled, protected, source FROM supported_mints WHERE mint = $1`,
    [BP_MINT],
  );
  console.log("Verified in DB:");
  console.log(rows[0]);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
