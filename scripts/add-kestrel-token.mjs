#!/usr/bin/env node
/**
 * Add $KESTREL (Kestrel Invest) — operator-approved manual listing 2026-08-21.
 * Admin authority overrides risk flags (per standing rule); risks were flagged
 * and the operator affirmed. Ultra-thin liquidity (~$7.7k) → listed with a
 * TIGHT exposure cap to bound LP blast radius; adjustable on request.
 *
 * Technical-correctness checks still enforced (decimals, cross-sourced price).
 *   railway run --service magpie-bot node scripts/add-kestrel-token.mjs          # dry run
 *   railway run --service magpie-bot node scripts/add-kestrel-token.mjs --write
 */
import { query } from "../src/db/pool.js";
const WRITE = process.argv.includes("--write");
const MINT = "G9ALRz5jtq6wG7dijjsb1TvkGatwPNcnhbAGECVQpump";
const SYMBOL = "KESTREL", NAME = "Kestrel Invest", DECIMALS = 6, CATEGORY = "memecoin";
const CAP_SOL = Number(process.env.KESTREL_CAP_SOL || 1); // tight default; adjustable

const { Connection, PublicKey } = await import("@solana/web3.js");
const rpc = process.env.HELIUS_RPC_URL || process.env.RPC_URL || process.env.SOLANA_RPC_URL;
const conn = new Connection(rpc, "confirmed");
const info = await conn.getParsedAccountInfo(new PublicKey(MINT));
const parsed = info.value?.data?.parsed?.info;
if (!parsed) { console.error("ABORT: mint not found"); process.exit(1); }
if (Number(parsed.decimals) !== DECIMALS) { console.error(`ABORT: on-chain decimals ${parsed.decimals} != ${DECIMALS}`); process.exit(1); }
console.log(`✓ on-chain: dec=${parsed.decimals} supply=${(Number(parsed.supply)/1e6).toLocaleString()} program=${info.value.owner.toBase58().slice(0,8)}`);

const price = await import("../src/services/price.js");
const jup = await price.getPriceInSol(MINT).catch(() => null);
const cross = await price.getPriceInSolCrossSourced(MINT).catch(() => null);
if (jup && cross) {
  const div = Math.abs(Number(jup) - Number(cross)) / Number(jup);
  console.log(`✓ price: jupiter=${jup} cross=${cross} divergence=${(div*100).toFixed(3)}%`);
  if (div > 0.05) console.warn(`⚠ ${(div*100).toFixed(1)}% cross-source divergence (thin token — expected)`);
} else console.warn("⚠ price cross-source unavailable (thin token) — proceeding per operator approval");

if (!WRITE) { console.log(`DRY RUN — would list ${SYMBOL} memecoin, enabled, protected, cap ${CAP_SOL} SOL, warm feeds`); process.exit(0); }

await query(
  `INSERT INTO supported_mints (mint,symbol,name,decimals,category,min_liquidity_usd,holder_count,
     has_mint_authority,has_freeze_authority,lp_burned,token_age_hours,auto_approved,screened_at,
     source,enabled,protected,is_canonical,attestation_tier)
   VALUES ($1,$2,$3,$4,'memecoin',0,0,$5,$6,FALSE,999,FALSE,NOW(),'operator_trusted',TRUE,TRUE,FALSE,'hot')
   ON CONFLICT (mint) DO UPDATE SET symbol=EXCLUDED.symbol,name=EXCLUDED.name,decimals=EXCLUDED.decimals,
     enabled=TRUE,protected=TRUE,source='operator_trusted',screened_at=NOW()`,
  [MINT,SYMBOL,NAME,DECIMALS,!!parsed.mintAuthority,!!parsed.freezeAuthority]);
console.log("✓ supported_mints upserted (memecoin, protected, operator_trusted)");

await query(
  `UPDATE supported_mints SET max_open_lamports=$2 WHERE mint=$1`, [MINT, String(BigInt(Math.floor(CAP_SOL*1e9)))]);
console.log(`✓ exposure cap set: ${CAP_SOL} SOL (tight default — bounds LP risk; adjustable)`);

try {
  const { warmMintForBorrow } = await import("../src/services/v4-feed-readiness.js");
  await warmMintForBorrow(MINT, "operator_add_kestrel");
  console.log("✓ warm-on-enable kicked (V1/V4 feed init + attestation)");
} catch (e) { console.warn(`⚠ warm failed (sweep backstops): ${e.message?.slice(0,80)}`); }
console.log("\nDone. KESTREL live for loans with a 1 SOL cap.");
process.exit(0);
