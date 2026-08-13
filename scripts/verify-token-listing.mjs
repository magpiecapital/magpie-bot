#!/usr/bin/env node
/**
 * Verify a listed token is CORRECTLY and SAFELY configured.
 *
 * Operator standard, 2026-08-13 (adding $SILV):
 *   "Make sure it's properly added. With CA, ticker, Logo, and NO EXPLOITS or
 *    issues. Decimals and everything needs to be properly set. This needs to be
 *    done for all additions moving forward as well."
 *
 * A manual/operator add BYPASSES the automated screener, so this is the check
 * that replaces it. Run it after EVERY addition.
 *
 *   railway run --service magpie-bot node scripts/verify-token-listing.mjs SILV
 *   railway run --service magpie-bot node scripts/verify-token-listing.mjs --all
 *
 * WHY EACH CHECK EXISTS — none of these are hypothetical:
 *
 *  decimals     Collateral value = raw_amount / 10^decimals. Off by two (GLDx
 *               is 8, SILV is 6) mis-values collateral 100x — either the
 *               protocol lends 100x too much, or a borrower is liquidated
 *               holding 100x the debt. Verified against the CHAIN, never a
 *               token list.
 *  cross-source A single price source can be pumped. The oracle rule is
 *               Jupiter-primary cross-sourced, reject >3x divergence; this
 *               asserts the two agree TODAY, which is the $FATHER/Loopscale
 *               drain class.
 *  price feeds  An RWA needs V3 + V4 PDAs (memecoin: V1 + V4) initialized
 *               BEFORE anyone borrows, or Borrow fails AccountNotInitialized —
 *               the FARM and SPCX incidents.
 *  hot+protected Stocks/RWAs must never be auto-disabled by a liquidity dip
 *               and must always be freshly attested.
 *  logo/name    Cross-checked against ON-CHAIN metadata, not a third-party
 *               list, so a look-alike listing cannot borrow a real token's
 *               identity on our own surfaces.
 */
import { query } from "../src/db/pool.js";
import { connection } from "../src/solana/connection.js";
import { PublicKey } from "@solana/web3.js";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: verify-token-listing.mjs <SYMBOL|MINT|--all>");
  process.exit(1);
}

const where =
  arg === "--all"
    ? { sql: "enabled = TRUE", params: [] }
    : arg.length > 30
      ? { sql: "mint = $1", params: [arg] }
      : { sql: "UPPER(symbol) = UPPER($1)", params: [arg] };

const { rows } = await query(
  `SELECT mint, symbol, name, decimals, category, enabled, protected,
          is_canonical, attestation_tier, image_url, liquidity_usd, source
     FROM supported_mints WHERE ${where.sql} ORDER BY symbol`,
  where.params,
);
if (!rows.length) { console.error(`no listing matches ${arg}`); process.exit(1); }

const RWA = new Set(["stock", "etf", "metal"]);
let failures = 0, warnings = 0;
const ok = (m) => console.log(`   ✅ ${m}`);
const bad = (m) => { failures++; console.log(`   ❌ ${m}`); };
const warn = (m) => { warnings++; console.log(`   ⚠️  ${m}`); };

for (const t of rows) {
  console.log(`\n── ${t.symbol} (${t.name || "no name"}) ──`);
  console.log(`   ${t.mint}`);

  // 1. DECIMALS — against the chain, the single highest-consequence field.
  let onchain = null;
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(t.mint));
    onchain = info.value?.data?.parsed?.info;
    if (!onchain) bad("mint account not found / not a token mint");
    else if (Number(onchain.decimals) !== Number(t.decimals))
      bad(`DECIMALS MISMATCH: db=${t.decimals} chain=${onchain.decimals} — mis-values collateral by 10^${Math.abs(t.decimals - onchain.decimals)}`);
    else ok(`decimals ${t.decimals} match chain`);
  } catch (e) { bad(`chain read failed: ${e.message.slice(0, 60)}`); }

  // 2. IDENTITY vs on-chain metadata (name/symbol embedded in the mint).
  if (onchain) {
    try {
      const raw = (await connection.getAccountInfo(new PublicKey(t.mint)))?.data ?? Buffer.alloc(0);
      let cur = "", strs = [];
      for (const b of raw) { if (b >= 32 && b < 127) cur += String.fromCharCode(b); else { if (cur.length >= 3) strs.push(cur); cur = ""; } }
      if (cur.length >= 3) strs.push(cur);
      const blob = strs.join(" ").toUpperCase();
      if (strs.length === 0) warn("no on-chain metadata strings (older SPL mint) — identity unverifiable on-chain");
      else if (t.symbol && blob.includes(String(t.symbol).toUpperCase())) ok(`symbol "${t.symbol}" present in on-chain metadata`);
      else warn(`symbol "${t.symbol}" NOT found in on-chain metadata — confirm this is the right mint`);
    } catch { warn("metadata scan failed"); }
  }

  // 3. LOGO — present and actually loadable (a broken URL is a visible defect).
  if (!t.image_url) warn("no logo (image_url null) — the tokens page will render a blank tile");
  else {
    try {
      const r = await fetch(t.image_url, { method: "GET" });
      const ct = r.headers.get("content-type") || "";
      if (!r.ok) bad(`logo URL returns HTTP ${r.status}`);
      else if (!ct.startsWith("image/")) bad(`logo URL is not an image (content-type: ${ct})`);
      else if (!t.image_url.startsWith("https://")) bad("logo URL is not https — blocked by CSP");
      else ok(`logo loads (${ct})`);
    } catch (e) { warn(`logo fetch failed: ${e.message.slice(0, 50)}`); }
  }

  // 4. CROSS-SOURCED PRICE — the anti-manipulation gate.
  try {
    const price = await import("../src/services/price.js");
    const jup = Number(await price.getPriceInSol(t.mint));
    const cross = Number(await price.getPriceInSolCrossSourced(t.mint));
    if (!Number.isFinite(jup) || jup <= 0) bad("no usable price");
    else {
      const div = Math.abs(jup - cross) / jup;
      if (div > 0.03) bad(`cross-source divergence ${(div * 100).toFixed(2)}% exceeds 3%`);
      else ok(`price cross-sourced (divergence ${(div * 100).toFixed(4)}%)`);
    }
  } catch (e) { bad(`price check failed: ${e.message.slice(0, 70)}`); }

  // 5. PRICE-FEED PDAs — must exist BEFORE anyone can borrow.
  try {
    const { getPriceFeedAgeSeconds } = await import("../src/services/price-attestor.js");
    const { PROGRAM_ID, PROGRAM_ID_V3, PROGRAM_ID_V4 } = await import("../src/solana/program.js");
    const isRwa = RWA.has(t.category);
    const need = isRwa ? [["V3", PROGRAM_ID_V3], ["V4", PROGRAM_ID_V4]] : [["V1", PROGRAM_ID], ["V4", PROGRAM_ID_V4]];
    for (const [label, pid] of need) {
      if (!pid) { warn(`${label} program id not configured — cannot check`); continue; }
      const age = await getPriceFeedAgeSeconds(t.mint, pid);
      if (age === null) bad(`${label} price feed MISSING — Borrow will fail AccountNotInitialized`);
      else ok(`${label} price feed live (age ${Math.round(age)}s)`);
    }
  } catch (e) { bad(`feed check failed: ${e.message.slice(0, 70)}`); }

  // 6. RWA POSTURE — hot + protected is mandatory for stocks/metals.
  if (RWA.has(t.category)) {
    t.protected ? ok("protected (never auto-disabled on a liquidity dip)") : bad("RWA must be protected=TRUE");
    t.attestation_tier === "hot" ? ok("attestation_tier hot") : bad(`RWA must be tier 'hot', got '${t.attestation_tier}'`);
    if (!t.is_canonical) warn("is_canonical FALSE — RWAs should be canonically pinned");
    const { rows: pin } = await query(`SELECT issuer FROM canonical_rwa_mints WHERE mint = $1`, [t.mint]);
    pin.length ? ok(`canonically pinned (issuer=${pin[0].issuer})`) : warn("not in canonical_rwa_mints — pin it to prevent look-alike substitution");
  }

  // 7. Liquidity sanity — 0 means nothing populated it.
  if (Number(t.liquidity_usd) <= 0) warn("liquidity_usd is 0 — health/routing surfaces will read it as dead");
  else ok(`liquidity $${Math.round(Number(t.liquidity_usd)).toLocaleString()}`);
}

console.log(
  `\n${failures === 0 ? "✅" : "❌"} ${rows.length} listing(s): ${failures} failure(s), ${warnings} warning(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
