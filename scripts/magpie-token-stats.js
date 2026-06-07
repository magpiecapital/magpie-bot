#!/usr/bin/env node
// Pulls live on-chain stats for $MAGPIE to paste into verification forms
// (CoinGecko, Moonshot, Jupiter VRFD, etc.).
//
// Usage: node scripts/magpie-token-stats.js
//
// Outputs:
//   - Total supply (raw + human)
//   - Decimals
//   - Mint authority (should be null = renounced)
//   - Freeze authority
//   - Holder count (via Helius DAS if available)
//   - Top 5 holders (concentration check)

import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import { connection } from "../src/solana/connection.js";

const MAGPIE_MINT = "9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump";

function fmt(n, decimals) {
  const s = BigInt(n).toString();
  if (s.length <= decimals) {
    return "0." + s.padStart(decimals, "0");
  }
  const head = s.slice(0, s.length - decimals);
  const tail = s.slice(s.length - decimals);
  return Number(head + "." + tail).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  });
}

async function fetchSupply() {
  const info = await connection.getParsedAccountInfo(new PublicKey(MAGPIE_MINT));
  const parsed = info.value?.data?.parsed?.info;
  if (!parsed) throw new Error("Could not parse mint info");
  return {
    supply: parsed.supply,
    decimals: parsed.decimals,
    mintAuthority: parsed.mintAuthority ?? null,
    freezeAuthority: parsed.freezeAuthority ?? null,
    isInitialized: parsed.isInitialized,
  };
}

async function fetchHoldersViaHelius() {
  const apiKey = process.env.HELIUS_API_KEY
    || (process.env.SOLANA_RPC_URL?.match(/api-key=([a-f0-9-]+)/i)?.[1])
    || (process.env.HELIUS_RPC_URL?.match(/api-key=([a-f0-9-]+)/i)?.[1]);
  if (!apiKey) return null;

  // DAS: get all token accounts for this mint, paginate
  const holders = new Map(); // owner -> total balance (bigint)
  let page = 1;
  const limit = 1000;

  while (true) {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "magpie-holders",
        method: "getTokenAccounts",
        params: { mint: MAGPIE_MINT, page, limit },
      }),
    });
    const json = await res.json();
    const accounts = json?.result?.token_accounts ?? [];
    if (accounts.length === 0) break;

    for (const a of accounts) {
      const amt = BigInt(a.amount ?? 0);
      if (amt === 0n) continue;
      const owner = a.owner;
      holders.set(owner, (holders.get(owner) ?? 0n) + amt);
    }

    if (accounts.length < limit) break;
    page += 1;
    if (page > 50) break; // safety stop
  }

  return holders;
}

(async () => {
  console.log("\n=== $MAGPIE on-chain stats ===\n");
  console.log("Mint:    ", MAGPIE_MINT);

  const supplyInfo = await fetchSupply();
  console.log("Decimals:", supplyInfo.decimals);
  console.log("Total supply (raw):  ", supplyInfo.supply);
  console.log("Total supply (human):", fmt(supplyInfo.supply, supplyInfo.decimals));
  console.log("Mint authority:      ", supplyInfo.mintAuthority ?? "null (renounced) ✅");
  console.log("Freeze authority:    ", supplyInfo.freezeAuthority ?? "null ✅");
  console.log("Initialized:         ", supplyInfo.isInitialized);

  const holders = await fetchHoldersViaHelius();
  if (!holders) {
    console.log("\n(Helius API key not found — skipping holder count.)");
    console.log("Set HELIUS_API_KEY in .env or check Solscan manually:");
    console.log(`  https://solscan.io/token/${MAGPIE_MINT}#holders`);
  } else {
    const total = [...holders.values()].reduce((a, b) => a + b, 0n);
    console.log("\nHolder count:", holders.size.toLocaleString());
    console.log("Sum of holder balances:", fmt(total, supplyInfo.decimals));

    const sorted = [...holders.entries()].sort((a, b) =>
      a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0,
    );
    console.log("\nTop 5 holders (concentration check):");
    for (let i = 0; i < Math.min(5, sorted.length); i++) {
      const [owner, bal] = sorted[i];
      const pct = Number((bal * 10000n) / total) / 100;
      console.log(`  ${i + 1}. ${owner}  ${fmt(bal, supplyInfo.decimals)}  (${pct.toFixed(2)}%)`);
    }
  }

  console.log("\nPaste-ready for verification forms:");
  console.log("------------------------------------");
  console.log(`Contract: ${MAGPIE_MINT}`);
  console.log(`Chain: Solana`);
  console.log(`Token program: Token-2022`);
  console.log(`Decimals: ${supplyInfo.decimals}`);
  console.log(`Max supply: ${fmt(supplyInfo.supply, supplyInfo.decimals)}`);
  console.log(`Circulating supply: ${fmt(supplyInfo.supply, supplyInfo.decimals)}  (mint auth = ${supplyInfo.mintAuthority ?? "renounced"})`);
  if (holders) console.log(`Holders: ${holders.size.toLocaleString()}`);
  console.log(`Solscan: https://solscan.io/token/${MAGPIE_MINT}`);
  console.log(`Explorer: https://explorer.solana.com/address/${MAGPIE_MINT}`);
  console.log("------------------------------------\n");

  process.exit(0);
})().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
