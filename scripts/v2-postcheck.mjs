import "dotenv/config";
import { PublicKey, Connection } from "@solana/web3.js";
const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
const V2 = new PublicKey(process.env.PROGRAM_ID_V2);
const LENDER = new PublicKey(process.env.LENDER_PUBKEY);
const { lendingPoolPda, loanTokenVaultPda } = await import("../src/solana/pdas.js");
const { getReadOnlyProgram } = await import("../src/solana/program.js");
const [pool] = lendingPoolPda(LENDER, V2);
const [vault] = loanTokenVaultPda(pool, V2);
const program = getReadOnlyProgram(V2);
const p = await program.account.lendingPool.fetch(pool);
const vi = await conn.getAccountInfo(vault);
const lender_sol = (await conn.getBalance(LENDER)) / 1e9;
const fmt = (n) => (Number(n)/1e9).toFixed(6);
console.log("V2 pool state POST-WINDOWN:");
console.log("  totalDeposits =", fmt(p.totalDeposits));
console.log("  totalBorrowed =", fmt(p.totalBorrowed));
console.log("  totalFeesEarned =", fmt(p.totalFeesEarned), "(phantom accounting — no real SOL)");
console.log("  totalShares =", p.totalShares?.toString?.() ?? "n/a");
console.log("  vault SOL =", vi ? (vi.lamports/1e9).toFixed(6) : "MISSING");
console.log("  lender wallet SOL =", lender_sol.toFixed(6));
// Lender's V2 DepositorPosition: should be closed or zero
const dpAccts = await conn.getProgramAccounts(V2, {
  filters: [{ dataSize: 97 }, { memcmp: { offset: 8, bytes: LENDER.toBase58() } }, { memcmp: { offset: 40, bytes: pool.toBase58() } }],
});
console.log("  lender DepositorPosition accounts:", dpAccts.length);
for (const a of dpAccts) {
  const dp = await program.account.depositorPosition.fetch(a.pubkey);
  console.log("    shares =", dp.shares.toString());
}
// Any remaining loans on V2?
const allAccts = await conn.getProgramAccounts(V2, { dataSlice: { offset: 0, length: 8 } });
const loanDisc = Buffer.from([20,195,70,117,165,227,182,1]); // Loan discriminator
const remainingLoans = allAccts.filter(a => Buffer.compare(a.account.data, loanDisc) === 0);
console.log("  remaining Loan accounts on V2:", remainingLoans.length);
process.exit(0);
