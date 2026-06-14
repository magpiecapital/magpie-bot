import { Connection, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import anchor from "@coral-xyz/anchor";
import "dotenv/config";

const RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const conn = new Connection(RPC, "confirmed");

const LENDER = new PublicKey("4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx");

const TARGETS = [
  ["V1", "/Users/USER/bagbank-bot/src/solana/idl/magpie_lending.json", "4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh"],
  ["V2", "/Users/USER/bagbank-bot/src/solana/idl/magpie_lending_v2.json", "6wSpKAGuiRf3nYHj9raVwmoTPbG5MswBzTy6aMXZHBe"],
];

for (const [name, idlPath, programIdStr] of TARGETS) {
  console.log(`\n========== ${name} (${programIdStr}) ==========`);
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const provider = new anchor.AnchorProvider(
    conn,
    {
      publicKey: PublicKey.default,
      signTransaction: async (t) => t,
      signAllTransactions: async (txs) => txs,
    },
    { commitment: "confirmed" },
  );
  const program = new anchor.Program(idl, provider);
  const programId = new PublicKey(programIdStr);

  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), LENDER.toBuffer()],
    programId,
  );

  const acct = await conn.getAccountInfo(pool);
  const buf = acct.data;
  let off = 8 + 32 + 32 + 32 + 2 + 2;
  const totalDeposits = buf.readBigUInt64LE(off);
  off += 8;
  const totalShares = buf.readBigUInt64LE(off);
  off += 8;
  const totalBorrowed = buf.readBigUInt64LE(off);

  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("loan-token-vault"), pool.toBuffer()],
    programId,
  );
  const vaultBal = BigInt(
    (await conn.getTokenAccountBalance(vault)).value.amount,
  );

  const valuePerShare = totalShares > 0n
    ? Number(totalDeposits) / Number(totalShares)
    : 1;

  console.log(`pool.total_deposits:  ${(Number(totalDeposits) / 1e9).toFixed(6)} SOL`);
  console.log(`pool.total_shares:    ${(Number(totalShares) / 1e9).toFixed(6)} (share-units)`);
  console.log(`pool.total_borrowed:  ${(Number(totalBorrowed) / 1e9).toFixed(6)} SOL`);
  console.log(`vault wSOL balance:   ${(Number(vaultBal) / 1e9).toFixed(6)} SOL`);
  console.log(`share value (deposits/shares): ${valuePerShare.toFixed(6)} SOL/share`);
  const expected = totalDeposits - totalBorrowed;
  const excess = vaultBal - expected;
  console.log(`vault excess (actual - expected): ${(Number(excess) / 1e9).toFixed(6)} SOL`);

  console.log("\nEnumerating DepositorPosition accounts...");
  const positions = await program.account.depositorPosition.all();
  console.log(`Total LP positions: ${positions.length}`);

  positions.sort((a, b) => Number(b.account.shares) - Number(a.account.shares));

  let sumShares = 0n;
  let sumDeposited = 0n;

  console.log("\nPer-LP positions (sorted by shares desc):");
  for (const p of positions) {
    const a = p.account;
    const shares = BigInt(a.shares.toString());
    const deposited = BigInt(a.depositedAmount.toString());
    sumShares += shares;
    sumDeposited += deposited;

    const currentValue = totalShares > 0n
      ? (shares * totalDeposits) / totalShares
      : 0n;
    const lpFractionOfShares = totalShares > 0n
      ? Number(shares) / Number(totalShares)
      : 0;
    const lpFractionOfExcess = excess > 0n
      ? Number(excess) * lpFractionOfShares
      : 0;

    console.log({
      owner: a.owner.toBase58().slice(0, 12) + "…",
      shares_units: (Number(shares) / 1e9).toFixed(6),
      lifetime_deposited_sol: (Number(deposited) / 1e9).toFixed(6),
      current_withdraw_value_sol: (Number(currentValue) / 1e9).toFixed(6),
      net_pnl_sol: ((Number(currentValue) - Number(deposited)) / 1e9).toFixed(6),
      uncredited_yield_estimate_sol: (lpFractionOfExcess / 1e9).toFixed(6),
      share_of_pool_pct: (lpFractionOfShares * 100).toFixed(2),
    });
  }

  console.log(`\nSum LP shares: ${(Number(sumShares) / 1e9).toFixed(6)}`);
  console.log(`Sum LP lifetime deposited: ${(Number(sumDeposited) / 1e9).toFixed(6)} SOL`);
  console.log(
    `Sum LP shares matches pool.total_shares? ${
      sumShares === totalShares ? "YES (exact)" : `NO (drift ${(Number(sumShares - totalShares) / 1e9).toFixed(6)})`
    }`,
  );

  if (excess > 0n) {
    console.log(
      `\nVault excess of ${(Number(excess) / 1e9).toFixed(6)} SOL would be the maximum LP true-up budget. ` +
      `Per-LP share is shown above as 'uncredited_yield_estimate_sol' (proportional to share-of-pool). ` +
      `This estimate assumes ALL vault excess is unclaimed LP yield, which is an upper bound — some may be misroutes that belong to the operator.`,
    );
  }
}
