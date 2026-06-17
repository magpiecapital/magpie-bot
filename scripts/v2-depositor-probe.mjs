import "dotenv/config";
import { PublicKey, Connection } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
const V2 = new PublicKey(process.env.PROGRAM_ID_V2);
const LENDER = new PublicKey(process.env.LENDER_PUBKEY);

// Probe ALL V2 program-owned accounts by size — figure out what DepositorPosition's real size is.
const all = await conn.getProgramAccounts(V2, { dataSlice: { offset: 0, length: 0 } });
console.log("Total V2 program accounts:", all.length);

// Bucket by size to find the DepositorPosition discriminator
const bySize = new Map();
for (const a of all) {
  // dataSlice returned only header; need to re-fetch to get true length. Do it cheaply.
}
// Re-fetch with full data to bucket sizes
const sizes = new Map();
const owners = new Map(); // for DepositorPosition, the owner field is at a known offset
let depositorCandidates = [];

for (const a of all) {
  const info = await conn.getAccountInfo(a.pubkey);
  if (!info) continue;
  const sz = info.data.length;
  sizes.set(sz, (sizes.get(sz) || 0) + 1);
  // Anchor: first 8 bytes = discriminator. DepositorPosition typically has fields:
  // depositor (Pubkey 32) + pool (Pubkey 32) + share_amount (u64 8) + ... 
  // Try interpret offset 8 (post-discriminator) as a Pubkey
  if (sz >= 48) {
    try {
      const maybeOwner = new PublicKey(info.data.slice(8, 8 + 32));
      const maybePool = new PublicKey(info.data.slice(40, 40 + 32));
      // Filter: pool field should reference V2's pool PDA
      depositorCandidates.push({ pda: a.pubkey.toBase58(), size: sz, possibleOwner: maybeOwner.toBase58(), possiblePool: maybePool.toBase58() });
    } catch { /* not a pubkey */ }
  }
}
console.log("\nAccount-size histogram (V2):");
for (const [sz, n] of [...sizes.entries()].sort((a,b)=>b[1]-a[1])) console.log(" size=" + sz + " n=" + n);

// Pull V2 pool PDA to filter candidates
const { lendingPoolPda } = await import("../src/solana/pdas.js");
const [pool] = lendingPoolPda(LENDER, V2);
console.log("\nV2 pool PDA:", pool.toBase58());

const validDepositors = depositorCandidates.filter(d => d.possiblePool === pool.toBase58());
console.log("\nCandidate DepositorPositions (pool matches):", validDepositors.length);
for (const d of validDepositors) console.log("  pda=" + d.pda, "depositor=" + d.possibleOwner, "size=" + d.size);

// Also: sum up DepositorPosition share amounts to cross-check pool.totalDeposits
if (validDepositors.length > 0) {
  let totalShares = 0n;
  for (const d of validDepositors) {
    const info = await conn.getAccountInfo(new PublicKey(d.pda));
    // share_amount at offset 8+32+32 = 72 (after disc+depositor+pool)
    if (info.data.length >= 80) {
      const shares = info.data.readBigUInt64LE(72);
      totalShares += shares;
      console.log("  depositor", d.possibleOwner.slice(0,8) + "..", "shares=" + shares.toString());
    }
  }
  console.log("\nSum of shares across depositors:", totalShares.toString());
}

process.exit(0);
