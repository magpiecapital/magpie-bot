#!/usr/bin/env node
/**
 * Add $MRNA (Moderna) + $LLY (Eli Lilly) — Backpack Securities tokenized
 * pharma equities. Operator-approved 2026-08-20 (Sunrise listing posts).
 *
 * Manual add bypasses the screener, so screener checks were done by hand:
 *
 *  identity  BOTH mints carry the Backpack ticker-vanity prefix (MRNAz…,
 *            LLYuw…) and the EXACT Token-2022 extension fingerprint of the
 *            known-good Backpack mints (MU/SPCX/MSTR): permanentDelegate +
 *            transferHook + pausable + confidentialTransfer + metadata.
 *            ⚠ An IMPERSONATOR exists for MRNA with the identical display
 *            name "Moderna - Backpack Securities" at CBDgKJ8v… priced at
 *            $0.0000113 — the canonical pin below is what keeps it out.
 *  market    MRNA: $133.24 on-chain vs $133.36 real equity (0.09% div),
 *            $178k liquidity. LLY: $1,254.13 vs $1,257.65 (0.28%), $79k
 *            liquidity — and independently within 0.6% of Backed's LLYx.
 *  config    category 'stock', hot + protected + canonical, issuer
 *            'backpack' — stocks/RWAs are ALWAYS hot per the standing rule.
 *  caps      premium_tier_whitelist rows (the AAPLx-incident lesson: an RWA
 *            without one falls into memecoin tiering and gets falsely
 *            demoted). Conservative 15 SOL caps — raise after depth history.
 *
 *   railway run --service magpie-bot node scripts/add-mrna-lly-tokens.mjs          # dry run
 *   railway run --service magpie-bot node scripts/add-mrna-lly-tokens.mjs --write
 */
import { query } from "../src/db/pool.js";
const WRITE = process.argv.includes("--write");

const TOKENS = [
  { MINT: "MRNAzXzhNcaEXJPibHEn8cd4vyekCDiivTyEwswLUCT", SYMBOL: "MRNA",
    NAME: "Moderna - Backpack Securities", DECIMALS: 6, CAP_SOL: 15,
    NOTE: "Moderna (Backpack). Verified 2026-08-20: on-chain T22 fingerprint matches MU/SPCX/MSTR; 0.09% divergence vs real equity. ⚠ impersonator with identical name exists at CBDgKJ8v… — canonical pin is load-bearing." },
  { MINT: "LLYuwZ33keFihgwoxXsBawy31AiRFLFSva32TYq5TvD", SYMBOL: "LLY",
    NAME: "Eli Lilly and Company - Backpack Securities", DECIMALS: 6, CAP_SOL: 15,
    NOTE: "Eli Lilly (Backpack). Verified 2026-08-20: 0.28% divergence vs real equity, 0.6% vs Backed LLYx (independent issuer cross-check). $79k pool — cap conservative until depth history accrues." },
];

const { Connection, PublicKey } = await import("@solana/web3.js");
const rpc = process.env.HELIUS_RPC_URL || process.env.RPC_URL || process.env.SOLANA_RPC_URL;
if (!rpc) { console.error("ABORT: no RPC configured"); process.exit(1); }
const conn = new Connection(rpc, "confirmed");
const price = await import("../src/services/price.js");

for (const T of TOKENS) {
  console.log(`\n── ${T.SYMBOL} ──`);
  const info = await conn.getParsedAccountInfo(new PublicKey(T.MINT));
  const parsed = info.value?.data?.parsed?.info;
  if (!parsed) { console.error("ABORT: mint not found"); process.exit(1); }
  if (Number(parsed.decimals) !== T.DECIMALS) {
    console.error(`ABORT: on-chain decimals ${parsed.decimals} != ${T.DECIMALS} — wrong decimals mis-value collateral by orders of magnitude`);
    process.exit(1);
  }
  const exts = (parsed.extensions || []).map((e) => e.extension);
  if (!exts.includes("permanentDelegate") || !exts.includes("transferHook")) {
    console.error(`ABORT: extension fingerprint doesn't match the Backpack issuer profile (got: ${exts.join(",")})`);
    process.exit(1);
  }
  console.log(`✓ on-chain: dec=${parsed.decimals} supply=${(Number(parsed.supply) / 1e6).toLocaleString()} fingerprint=backpack`);

  const jup = await price.getPriceInSol(T.MINT);
  const cross = await price.getPriceInSolCrossSourced(T.MINT);
  const div = Math.abs(Number(jup) - Number(cross)) / Number(jup);
  console.log(`✓ price: jupiter=${jup} cross=${cross} divergence=${(div * 100).toFixed(4)}%`);
  if (!Number.isFinite(Number(jup)) || Number(jup) <= 0) { console.error("ABORT: no usable price"); process.exit(1); }
  if (div > 0.03) { console.error(`ABORT: ${(div * 100).toFixed(2)}% cross-source divergence > 3%`); process.exit(1); }

  const existing = await query(`SELECT symbol, enabled FROM supported_mints WHERE mint = $1`, [T.MINT]);
  console.log(existing.rows.length ? `note: already present ${JSON.stringify(existing.rows[0])}` : "note: new listing");

  if (!WRITE) { console.log(`DRY RUN — would list ${T.SYMBOL} (stock, hot, protected, canonical, backpack) + whitelist ${T.CAP_SOL} SOL + warm V3+V4 feeds`); continue; }

  await query(
    `INSERT INTO supported_mints
       (mint, symbol, name, decimals, category, min_liquidity_usd,
        holder_count, has_mint_authority, has_freeze_authority, lp_burned,
        token_age_hours, auto_approved, screened_at, source,
        enabled, protected, is_canonical, attestation_tier)
     VALUES ($1,$2,$3,$4,'stock',0, 0,$5,$6,FALSE, 999,FALSE,NOW(),'operator_trusted', TRUE,TRUE,TRUE,'hot')
     ON CONFLICT (mint) DO UPDATE SET
       symbol=EXCLUDED.symbol, name=EXCLUDED.name, decimals=EXCLUDED.decimals,
       category='stock', enabled=TRUE, protected=TRUE, is_canonical=TRUE,
       attestation_tier='hot', source='operator_trusted', screened_at=NOW()`,
    [T.MINT, T.SYMBOL, T.NAME, T.DECIMALS, !!parsed.mintAuthority, !!parsed.freezeAuthority],
  );
  console.log("✓ supported_mints upserted");

  await query(
    `INSERT INTO canonical_rwa_mints (symbol, mint, issuer, notes)
     VALUES ($1,$2,'backpack',$3) ON CONFLICT (symbol) DO NOTHING`,
    [T.SYMBOL, T.MINT, T.NOTE],
  );
  console.log("✓ canonical_rwa_mints pinned");

  await query(
    `INSERT INTO premium_tier_whitelist (mint, symbol, max_open_lamports, enabled, added_at, added_by, notes, tier, max_ltv_bps)
     VALUES ($1,$2,$3,TRUE,NOW(),'operator-approved-2026-08-20',$4,'crypto_adjacent',3000)
     ON CONFLICT (mint) DO NOTHING`,
    [T.MINT, T.SYMBOL, String(T.CAP_SOL * 1e9), T.NOTE],
  );
  console.log(`✓ premium_tier_whitelist: ${T.CAP_SOL} SOL cap`);

  try {
    const { warmMintForBorrow } = await import("../src/services/v4-feed-readiness.js");
    await warmMintForBorrow(T.MINT, "operator_add_mrna_lly");
    console.log("✓ warm-on-enable kicked (V3 + V4 feed init + attestation)");
  } catch (e) { console.warn(`⚠ warm failed (30-min sweep backstops): ${e.message}`); }
}
console.log("\nDone.");
process.exit(0);
