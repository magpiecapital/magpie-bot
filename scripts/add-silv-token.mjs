#!/usr/bin/env node
/**
 * Add $SILV (Dominion Silver) — the protocol's 2nd tokenized precious metal.
 *
 * Operator-approved 2026-08-13. A manual add BYPASSES the automated screener,
 * so everything the screener would have checked was verified by hand first:
 *
 *   on-chain   Token-2022 mint, 6 decimals, supply 92,880.879236,
 *              mint+freeze authority present (normal and REQUIRED for an RWA —
 *              the issuer must be able to mint against deposits and freeze on
 *              redemption; GLDx has both too).
 *   identity   NOT a Backed xStock. Every one of the 16 canonical RWA mints
 *              carries the `Xs` vanity prefix and issuer=backed_finance; this
 *              is `SiLV…` from Dominion. Operator confirmed the issuer
 *              explicitly, so it is pinned as issuer='dominion' rather than
 *              being quietly filed under backed_finance.
 *   market     $64.51, ~$1.18M liquidity across 3 pairs, $187k 24h volume.
 *   oracle     Jupiter 0.85005927 SOL vs cross-sourced 0.84999670 SOL —
 *              0.007% divergence. This is the gate that matters: a mint whose
 *              sources disagree can be pumped into the collateral valuation.
 *
 * Config mirrors GLDx (the existing metal) exactly: category 'metal',
 * enabled, protected, canonical, attestation_tier 'hot'. Per the standing rule,
 * stocks/RWAs are ALWAYS hot + protected — never subject to auto-disable on a
 * liquidity dip, and always freshly attested.
 *
 * PDAs: a 'metal' is an RWA, so it needs V3 + V4 price feeds initialized BEFORE
 * anyone can borrow. Waiting for the 30-minute periodic sweep would leave a
 * window where Borrow fails with AccountNotInitialized, which is exactly the
 * FARM/SPCX incident. This calls warmMintForBorrow() to do it immediately.
 *
 *   railway run --service magpie-bot node scripts/add-silv-token.mjs          # dry run
 *   railway run --service magpie-bot node scripts/add-silv-token.mjs --write
 */
import { query } from "../src/db/pool.js";

const WRITE = process.argv.includes("--write");

const MINT = "SiLVFMgD3eD2rgK628NbTBq9MnuJF5FW2CRaVyTB35L";
const SYMBOL = "SILV";
const NAME = "Dominion Silver";
const DECIMALS = 6;          // verified on-chain (GLDx is 8 — do NOT copy it)
const CATEGORY = "metal";
const ISSUER = "dominion";

// ── Re-verify on-chain rather than trusting the constants above ────────────
const { Connection, PublicKey } = await import("@solana/web3.js");
const rpc = process.env.HELIUS_RPC_URL || process.env.RPC_URL || process.env.SOLANA_RPC_URL;
if (!rpc) { console.error("ABORT: no RPC configured"); process.exit(1); }
const conn = new Connection(rpc, "confirmed");

const info = await conn.getParsedAccountInfo(new PublicKey(MINT));
const parsed = info.value?.data?.parsed?.info;
if (!parsed) { console.error("ABORT: mint account not found or not a token mint"); process.exit(1); }
if (Number(parsed.decimals) !== DECIMALS) {
  console.error(`ABORT: on-chain decimals ${parsed.decimals} != expected ${DECIMALS}. Wrong decimals mis-value collateral by orders of magnitude.`);
  process.exit(1);
}
console.log(`✓ on-chain: decimals=${parsed.decimals} supply=${(Number(parsed.supply) / 10 ** parsed.decimals).toLocaleString()} program=${info.value.owner.toBase58()}`);

// ── Oracle gate: both sources must agree, or the valuation is manipulable ──
const price = await import("../src/services/price.js");
const jup = await price.getPriceInSol(MINT);
const cross = await price.getPriceInSolCrossSourced(MINT);
const div = Math.abs(Number(jup) - Number(cross)) / Number(jup);
console.log(`✓ price: jupiter=${jup} cross=${cross} divergence=${(div * 100).toFixed(4)}%`);
if (!Number.isFinite(Number(jup)) || Number(jup) <= 0) { console.error("ABORT: no usable price"); process.exit(1); }
if (div > 0.03) { console.error(`ABORT: ${(div * 100).toFixed(2)}% cross-source divergence exceeds the 3% bar`); process.exit(1); }

const existing = await query(`SELECT symbol, enabled, category FROM supported_mints WHERE mint = $1`, [MINT]);
console.log(existing.rows.length ? `note: already present -> ${JSON.stringify(existing.rows[0])}` : "note: not yet in supported_mints");

if (!WRITE) {
  console.log("\nDRY RUN — nothing written. Would:");
  console.log(`  1. upsert supported_mints  ${SYMBOL} (${NAME}) category=${CATEGORY} enabled protected canonical tier=hot`);
  console.log(`  2. pin canonical_rwa_mints ${SYMBOL} issuer=${ISSUER}  [APPEND-ONLY table]`);
  console.log("  3. warmMintForBorrow() → initialize V3 + V4 price-feed PDAs now");
  console.log("\nRe-run with --write to apply.\n");
  process.exit(0);
}

// ── 1. supported_mints — mirrors the GLDx row ─────────────────────────────
await query(
  `INSERT INTO supported_mints
     (mint, symbol, name, decimals, category, min_liquidity_usd,
      holder_count, has_mint_authority, has_freeze_authority, lp_burned,
      token_age_hours, auto_approved, screened_at, source,
      enabled, protected, is_canonical, attestation_tier)
   VALUES ($1,$2,$3,$4,$5,0,
           0,$6,$7,FALSE,
           999,FALSE,NOW(),'operator_trusted',
           TRUE,TRUE,TRUE,'hot')
   ON CONFLICT (mint) DO UPDATE SET
     symbol = EXCLUDED.symbol, name = EXCLUDED.name,
     decimals = EXCLUDED.decimals, category = EXCLUDED.category,
     enabled = TRUE, protected = TRUE, is_canonical = TRUE,
     attestation_tier = 'hot', source = 'operator_trusted',
     screened_at = NOW()`,
  [MINT, SYMBOL, NAME, DECIMALS, CATEGORY, !!parsed.mintAuthority, !!parsed.freezeAuthority],
);
console.log("✓ supported_mints upserted");

// ── 2. canonical pin — APPEND-ONLY (migration 021 blocks UPDATE by design) ──
await query(
  `INSERT INTO canonical_rwa_mints (symbol, mint, issuer, notes)
   VALUES ($1,$2,$3,$4) ON CONFLICT (symbol) DO NOTHING`,
  [SYMBOL, MINT, ISSUER,
   "Dominion Silver — 2nd tokenized precious metal. Operator-approved 2026-08-13. NOT a Backed xStock; verified on-chain (Token-2022, 6dp) with 0.007% cross-source price divergence."],
);
console.log("✓ canonical_rwa_mints pinned");

// ── 3. PDAs now, not in 30 minutes ────────────────────────────────────────
try {
  const { warmMintForBorrow } = await import("../src/services/v4-feed-readiness.js");
  await warmMintForBorrow(MINT, "operator_add_silv");
  console.log("✓ warm-on-enable kicked (V3 + V4 feed init + on-demand attestation)");
} catch (e) {
  console.warn(`⚠ warm-on-enable failed (30-min sweep backstops): ${e.message}`);
}

console.log("\nDone. Verify: price feeds initialized, /tokens lists SILV, and a borrow quote returns.\n");
process.exit(0);
