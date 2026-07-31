/**
 * One-shot: approve $CARDS (Collector Crypt) for lending — enabled=TRUE,
 * protected=TRUE, attestation_tier='hot'.
 *
 * Operator manual approval 2026-07-31 (full green light → screening bypassed per
 * feedback_operator_manual_token_approval_bypasses_screening):
 *   "We need $CARDS approved for lending on our platform ASAP … I give it the
 *    full green light: CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp"
 *
 * Verified on-chain / on markets before approval:
 *   - Classic SPL mint (Tokenkeg…), decimals=6.
 *   - mint authority + freeze authority BOTH renounced (fixed supply, no freeze).
 *   - ~$2.5M Raydium (CLMM) + Meteora liquidity, ~$1M 24h volume, price ~$0.15.
 *   - Jupiter-routable to USDC (~0.002% impact on ~$150 sell) → stays liquidatable,
 *     so it satisfies "collateral that can still sell itself".
 *
 * category='memecoin' (a volatile, DEX-priced platform token — NOT a stable
 * tokenized-stock, so standard memecoin LTV, routes V1 no-exit / V4 with-exit).
 * protected=TRUE = exempt from the hourly token-health auto-disable.
 * attestation_tier='hot' = TWAP feed kept continuously warm so first-attempt
 * borrows never hit a cold feed. Same profile as $SOLdiers / $BP.
 *
 * Idempotent: re-running refreshes metadata + re-applies the flags.
 *
 * Usage:
 *   railway run --service magpie-bot node scripts/add-cards-token.js
 */
import "dotenv/config";

const CARDS_MINT = "CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp";

async function main() {
  const { query } = await import("../src/db/pool.js");

  let symbol = "CARDS";
  let name = "Collector Crypt";
  let decimals = 6;
  let imageUrl = null;
  let liquidityUsd = 0;
  let volume24h = 0;
  let marketCap = 0;

  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${CARDS_MINT}`);
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
    const info = await connection.getAccountInfo(new PublicKey(CARDS_MINT));
    if (info?.data?.length >= 45) decimals = info.data.readUInt8(44);
  } catch (err) {
    console.warn("On-chain decimals lookup failed, using default:", err.message);
  }

  console.log(`Approving ${symbol} (${CARDS_MINT}):`);
  console.log(`  name: ${name}`);
  console.log(`  decimals: ${decimals}`);
  console.log(`  liquidity: $${Math.floor(liquidityUsd).toLocaleString()}  vol24h: $${Math.floor(volume24h).toLocaleString()}`);
  console.log(`  category: memecoin · enabled: TRUE · protected: TRUE · attestation_tier: hot`);
  console.log();

  await query(
    `INSERT INTO supported_mints
       (mint, symbol, name, decimals, category, image_url,
        liquidity_usd, holder_count, market_cap_usd,
        has_mint_authority, has_freeze_authority, lp_burned,
        token_age_hours, auto_approved, screened_at, source,
        enabled, protected, attestation_tier)
     VALUES ($1, $2, $3, $4, 'memecoin', $5,
             $6, 0, $7,
             FALSE, FALSE, FALSE,
             0, FALSE, NOW(), 'operator_approved',
             TRUE, TRUE, 'hot')
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
       protected = TRUE,
       attestation_tier = 'hot'`,
    [CARDS_MINT, symbol, name, decimals, imageUrl, liquidityUsd, marketCap],
  );

  await query(
    `INSERT INTO token_screen_seen (mint) VALUES ($1) ON CONFLICT DO NOTHING`,
    [CARDS_MINT],
  );

  const { rows } = await query(
    `SELECT mint, symbol, decimals, category, enabled, protected, attestation_tier, source
       FROM supported_mints WHERE mint = $1`,
    [CARDS_MINT],
  );
  console.log("Verified in DB:");
  console.log(rows[0]);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
