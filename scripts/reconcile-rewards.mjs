// On-chain forensic reconciliation of the rewards distribution wallet (CHCAM).
// Public RPC only — no creds. Reconstructs every native-SOL + wSOL movement,
// categorizes inflows (funding) vs outflows (holder payouts), by counterparty.
import { Connection, PublicKey } from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const CHCAM = "CHCAMWtnmgyjsJqHcq5MdeDdg4X3Ux1XAwA2rMCXj1Ac";
const LENDER = "4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx";
const WSOL = "So11111111111111111111111111111111111111112";
const c = new Connection(RPC, "confirmed");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(fn, label) {
  for (let i = 0; i < 6; i++) {
    try { return await fn(); }
    catch (e) {
      const rl = /429|rate|Too Many/i.test(e.message || "");
      if (i === 5) throw e;
      await sleep(rl ? 800 * (i + 1) : 300);
    }
  }
}

async function allSigs(addr) {
  const pk = new PublicKey(addr);
  let before, out = [];
  for (let p = 0; p < 12; p++) {
    const sigs = await withRetry(() => c.getSignaturesForAddress(pk, { limit: 1000, before }, "confirmed"));
    if (!sigs.length) break;
    out.push(...sigs);
    before = sigs[sigs.length - 1].signature;
    if (sigs.length < 1000) break;
  }
  return out;
}

function ownerWsolDelta(meta, owner) {
  // sum wSOL token-balance delta across token accounts owned by `owner`
  const pre = (meta.preTokenBalances || []).filter((b) => b.owner === owner && b.mint === WSOL);
  const post = (meta.postTokenBalances || []).filter((b) => b.owner === owner && b.mint === WSOL);
  const sum = (arr) => arr.reduce((s, b) => s + Number(b.uiTokenAmount.amount), 0);
  return (sum(post) - sum(pre)); // lamports
}

const sigs = await allSigs(CHCAM);
console.error(`fetched ${sigs.length} sigs; decoding…`);

let nativeIn = 0, nativeOut = 0, wsolIn = 0, wsolOut = 0, failed = 0, decoded = 0;
const inflowBySource = new Map();   // counterparty -> lamports (native+wsol) into CHCAM
const outflowByDest = new Map();    // counterparty -> lamports out of CHCAM
const payoutRecipients = new Set(); // distinct outflow recipients (holders)
let payoutTotal = 0, payoutCount = 0;
const monthly = new Map();          // YYYY-MM -> {in, out}

for (let i = 0; i < sigs.length; i++) {
  const s = sigs[i];
  if (s.err) { failed++; continue; }
  let tx;
  try {
    tx = await withRetry(() => c.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }));
  } catch { failed++; continue; }
  if (!tx || !tx.meta) { failed++; continue; }
  decoded++;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const idx = keys.indexOf(CHCAM);
  const nDelta = idx >= 0 ? (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) : 0;
  const wDelta = ownerWsolDelta(tx.meta, CHCAM);
  const totalDelta = nDelta + wDelta;
  const ym = new Date(s.blockTime * 1000).toISOString().slice(0, 7);
  const m = monthly.get(ym) || { in: 0, out: 0 };

  if (nDelta > 0) nativeIn += nDelta; else nativeOut += -nDelta;
  if (wDelta > 0) wsolIn += wDelta; else wsolOut += -wDelta;

  // counterparty = account with the largest opposite native delta
  let cp = null, cpDelta = 0;
  for (let j = 0; j < keys.length; j++) {
    if (j === idx) continue;
    const d = tx.meta.postBalances[j] - tx.meta.preBalances[j];
    if (Math.sign(d) === -Math.sign(totalDelta || nDelta) && Math.abs(d) > Math.abs(cpDelta)) { cpDelta = d; cp = keys[j]; }
  }
  if (!cp) cp = "(self/fee/unknown)";

  if (totalDelta > 0) {
    m.in += totalDelta;
    inflowBySource.set(cp, (inflowBySource.get(cp) || 0) + totalDelta);
  } else if (totalDelta < 0) {
    m.out += -totalDelta;
    outflowByDest.set(cp, (outflowByDest.get(cp) || 0) + (-totalDelta));
    // a payout = native outflow to a wallet that isn't the lender/treasury/self
    if (nDelta < 0 && cp !== LENDER && cp !== CHCAM && !cp.startsWith("(")) {
      payoutRecipients.add(cp); payoutTotal += -nDelta; payoutCount++;
    }
  }
  monthly.set(ym, m);
  if (i % 50 === 0) { console.error(`  ${i}/${sigs.length}`); await sleep(60); }
}

const sol = (l) => (l / 1e9).toFixed(4);
console.log("\n================ DISTRIBUTION WALLET (CHCAM) — ON-CHAIN RECONCILIATION ================");
console.log(`txns: ${sigs.length}  decoded: ${decoded}  failed/err: ${failed}`);
console.log(`\nNATIVE SOL:  in ${sol(nativeIn)}   out ${sol(nativeOut)}   net ${sol(nativeIn - nativeOut)}`);
console.log(`wSOL:        in ${sol(wsolIn)}   out ${sol(wsolOut)}   net ${sol(wsolIn - wsolOut)}`);
console.log(`COMBINED:    in ${sol(nativeIn + wsolIn)}   out ${sol(nativeOut + wsolOut)}   net ${sol(nativeIn + wsolIn - nativeOut - wsolOut)}`);
console.log(`\nHOLDER PAYOUTS (native out to non-protocol wallets): ${sol(payoutTotal)} SOL across ${payoutCount} transfers to ${payoutRecipients.size} distinct wallets`);

console.log(`\nTOP INFLOW SOURCES (who funded the rewards wallet):`);
[...inflowBySource.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  .forEach(([k, v]) => console.log(`   +${sol(v).padStart(10)} SOL   ${k}`));

console.log(`\nTOP OUTFLOW DESTINATIONS:`);
[...outflowByDest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  .forEach(([k, v]) => console.log(`   -${sol(v).padStart(10)} SOL   ${k}${k === LENDER ? "  (← back to lender)" : ""}`));

console.log(`\nMONTHLY:`);
[...monthly.entries()].sort().forEach(([ym, m]) => console.log(`   ${ym}   in ${sol(m.in).padStart(10)}   out ${sol(m.out).padStart(10)}`));
console.log("=====================================================================================");
