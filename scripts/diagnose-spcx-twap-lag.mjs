/**
 * Read-only diagnosis: why did SPCX V3 PriceHistory TWAP lag spot
 * tonight (2026-06-17 PM)?
 *
 * V2: enumerate operator's RECENT SPCX loans (last 24h), find the actual
 * mint + program_id the borrow targeted, derive the matching feed PDA,
 * dump samples + gaps + TWAP vs spot.
 */
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { query } from "../src/db/pool.js";

const PROGRAM_ID_V1 = new PublicKey("4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh");
const PROGRAM_ID_V3 = new PublicKey("B8AwYzFmc3ZB5EWWVtJcJhJtEmKL78W5i3kZrL1uMCmP");
const PROGRAM_ID_V4 = new PublicKey("HA1hgvskN1goEsb33rNHFBcDXBaYyLyyqfGwGMgTUwNo");

// Inline PDAs (V3/V4 use "price_v3" seed; pool seed "pool" everywhere).
// Bypasses pdas.js which reads env at module-load and falls back to V1's
// "price" seed when PROGRAM_ID_V3/V4 env vars aren't set.
function lendingPoolPda(lender, programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), lender.toBuffer()], programId,
  );
}
function priceFeedPda(mint, pool, programId) {
  const isV3OrV4 = programId.equals(PROGRAM_ID_V3) || programId.equals(PROGRAM_ID_V4);
  const seed = isV3OrV4 ? "price_v3" : "price";
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed), mint.toBuffer(), pool.toBuffer()], programId,
  );
}

const RPC_URL = process.env.SOLANA_RPC_URL;
const LENDER_PUBKEY = new PublicKey(process.env.LENDER_PUBKEY);
const conn = new Connection(RPC_URL, "confirmed");

const MIN_HISTORY_SECONDS = 300;
const MIN_SAMPLES = 8;
const MAX_PUMP_BPS = 1500;

function decodePriceHistory(data) {
  const headIndex = data.readUInt8(104);
  const count = data.readUInt8(105);
  const samplesOffset = 112;
  const stride = 16;
  const samples = [];
  for (let i = 0; i < count; i++) {
    const slotOff = samplesOffset + i * stride;
    const priceLamports = data.readBigUInt64LE(slotOff);
    const ts = data.readBigInt64LE(slotOff + 8);
    samples.push({ slot: i, priceLamports, ts: Number(ts) });
  }
  samples.sort((a, b) => a.ts - b.ts);
  return { headIndex, count, samples };
}

function programLabel(pidStr) {
  if (pidStr === PROGRAM_ID_V1.toBase58()) return "V1";
  if (pidStr === PROGRAM_ID_V3.toBase58()) return "V3";
  if (pidStr === PROGRAM_ID_V4.toBase58()) return "V4";
  return "?";
}

console.log("\n=== Recent SPCX loans (last 24h) for any operator wallet ===\n");

const { rows: loanRows } = await query(
  `SELECT l.id, l.user_id, l.borrower_wallet, l.collateral_mint, l.program_id,
          l.start_timestamp, l.loan_amount_lamports, l.status, sm.symbol, sm.category
     FROM loans l
     LEFT JOIN supported_mints sm ON sm.mint = l.collateral_mint
    WHERE sm.symbol = 'SPCX'
      AND l.start_timestamp > NOW() - INTERVAL '24 hours'
    ORDER BY l.id DESC
    LIMIT 10`,
);
if (loanRows.length === 0) {
  console.log("(no SPCX loans in last 24h)");
} else {
  for (const l of loanRows) {
    console.log(`  loan #${l.id}  ${programLabel(l.program_id)}  ${l.status}  ${l.start_timestamp.toISOString()}  ${(Number(l.loan_amount_lamports)/1e9).toFixed(4)} SOL  user=${l.user_id}  mint=${l.collateral_mint}  cat=${l.category}`);
  }
}

// Distinct (mint, program_id) combos that need feed inspection
const combos = new Map();
for (const l of loanRows) {
  const key = `${l.collateral_mint}|${l.program_id}`;
  if (!combos.has(key)) combos.set(key, { mint: l.collateral_mint, programId: l.program_id, symbol: l.symbol });
}
// Always also check canonical SPCX on V3 + V4 even if no recent loans
const { rows: spcxMints } = await query(
  `SELECT mint, symbol, name, decimals, category, is_canonical FROM supported_mints
    WHERE UPPER(symbol) = 'SPCX' AND enabled = TRUE ORDER BY is_canonical DESC`,
);
for (const m of spcxMints) {
  for (const pid of [PROGRAM_ID_V3.toBase58(), PROGRAM_ID_V4.toBase58()]) {
    const key = `${m.mint}|${pid}`;
    if (!combos.has(key)) combos.set(key, { mint: m.mint, programId: pid, symbol: m.symbol });
  }
}

const nowSec = Math.floor(Date.now() / 1000);
console.log(`\n(now=${new Date().toISOString()} epoch=${nowSec})\n`);

for (const { mint, programId, symbol } of combos.values()) {
  const programPk = new PublicKey(programId);
  const mintPk = new PublicKey(mint);
  const [poolPda] = lendingPoolPda(LENDER_PUBKEY, programPk);
  const [feedPda] = priceFeedPda(mintPk, poolPda, programPk);
  const tag = programLabel(programId);
  console.log(`\n--- ${symbol} on ${tag} (${programId.slice(0,8)}…)`);
  console.log(`  mint=${mint}`);
  console.log(`  pool=${poolPda.toBase58()}`);
  console.log(`  feed=${feedPda.toBase58()}`);

  const [poolInfo, feedInfo] = await Promise.all([
    conn.getAccountInfo(poolPda),
    conn.getAccountInfo(feedPda),
  ]);
  console.log(`  pool exists=${!!poolInfo} owner=${poolInfo?.owner.toBase58() ?? "n/a"}`);
  if (!feedInfo) {
    console.log(`  feed exists=NO — never attested for this (mint, pool) pair`);
    continue;
  }
  console.log(`  feed bytes=${feedInfo.data.length}`);
  if (feedInfo.data.length < 112) {
    console.log(`  → too small to be V3/V4 PriceHistory`);
    continue;
  }
  const { headIndex, count, samples } = decodePriceHistory(feedInfo.data);
  console.log(`  head_index=${headIndex} count=${count}`);
  if (samples.length === 0) {
    console.log(`  → no samples`);
    continue;
  }
  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  const oldestAge = nowSec - oldest.ts;
  const newestAge = nowSec - newest.ts;
  console.log(`\n  All samples (oldest→newest):`);
  let prevTs = null;
  let gaps = [];
  for (const s of samples) {
    const age = nowSec - s.ts;
    const gap = prevTs ? s.ts - prevTs : 0;
    if (prevTs) gaps.push(gap);
    const gapStr = prevTs ? `gap=+${String(gap).padStart(4," ")}s` : "gap=  ----";
    const priceStr = String(s.priceLamports).padStart(15, " ");
    console.log(`    age=${String(age).padStart(5," ")}s   ${gapStr}   price_lamports=${priceStr}`);
    prevTs = s.ts;
  }
  const inWin = samples.filter(s => nowSec - s.ts <= MIN_HISTORY_SECONDS);
  const twap = inWin.length > 0
    ? inWin.reduce((a, s) => a + Number(s.priceLamports), 0) / inWin.length
    : 0;
  const latestPrice = Number(newest.priceLamports);
  const ratio = twap > 0 ? latestPrice / twap : NaN;
  const bps = twap > 0 ? Math.round((ratio - 1) * 10_000) : 0;
  console.log(`\n  Window (last ${MIN_HISTORY_SECONDS}s):`);
  console.log(`    samples_in_window=${inWin.length} (need >= ${MIN_SAMPLES})`);
  console.log(`    oldest_in_window_age=${inWin[0] ? nowSec - inWin[0].ts : "n/a"}s (need >= ${MIN_HISTORY_SECONDS})`);
  console.log(`    newest_age=${newestAge}s`);
  console.log(`    twap=${twap.toFixed(0)}`);
  console.log(`    latest=${latestPrice}`);
  console.log(`    latest/twap = ${ratio.toFixed(4)} (+${bps} bps;   max=${MAX_PUMP_BPS})`);
  if (bps > MAX_PUMP_BPS) console.log(`    ⚠️  CURRENTLY exceeds pump threshold`);
  else                    console.log(`    ✓ within pump threshold currently`);
  if (gaps.length) {
    const maxGap = Math.max(...gaps);
    const avg = Math.round(gaps.reduce((a,b)=>a+b,0)/gaps.length);
    const over60 = gaps.filter(g => g > 60).length;
    const over120 = gaps.filter(g => g > 120).length;
    console.log(`\n  Gap stats: avg=${avg}s max=${maxGap}s gaps>60s=${over60}/${gaps.length} gaps>120s=${over120}/${gaps.length}`);
    if (maxGap > 60) console.log(`    ⚠️  Attestor dropped samples — TWAP weighted on stale points`);
    else             console.log(`    ✓ cadence healthy (max gap < 60s)`);
  }
}

process.exit(0);
