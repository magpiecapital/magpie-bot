/**
 * V2 program close — Phase 6 of the wind-down.
 *
 * Closes BOTH the program account (6wSpKA...) AND the program-data
 * account (4MebVY...). Sends all rent (~4.165 SOL) to the upgrade
 * authority, which is also the lender wallet.
 *
 * Run without args = DRY RUN. With --execute = broadcast.
 *
 * Operator-authorized 2026-06-17 PM after re-verifying:
 *   - pool.totalDeposits = 0
 *   - pool.totalBorrowed = 0
 *   - pool.totalShares = 0
 *   - All 21 V2 Loan accounts in terminal status (no user action possible)
 *   - V1/V3/V4 fully independent on-chain
 *   - Bot + site code paths neutralized (PROGRAM_ID_V2 = null)
 */
import "dotenv/config";
import {
  PublicKey, Connection, Transaction, TransactionInstruction, ComputeBudgetProgram, Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import fs from "node:fs";

const DRY_RUN = !process.argv.includes("--execute");
console.log(`\n[v2-close] mode=${DRY_RUN ? "DRY-RUN" : "EXECUTE"}\n`);

// Lender keypair (also the upgrade authority)
const decodeBs58 = bs58.decode || (bs58.default && bs58.default.decode);
let LENDER_KP;
if (process.env.LENDER_PRIVATE_KEY) {
  LENDER_KP = Keypair.fromSecretKey(decodeBs58(process.env.LENDER_PRIVATE_KEY));
} else if (process.env.LENDER_KEYPAIR_PATH) {
  LENDER_KP = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.LENDER_KEYPAIR_PATH, "utf-8"))));
} else { throw new Error("LENDER_PRIVATE_KEY or LENDER_KEYPAIR_PATH must be set"); }
const LENDER = LENDER_KP.publicKey;

const V2_PROGRAM = new PublicKey("6wSpKAGuiRf3nYHj9raVwmoTPbG5MswBzTy6aMXZHBe");
const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");

// Derive program-data PDA
const [programData] = PublicKey.findProgramAddressSync([V2_PROGRAM.toBuffer()], BPF_LOADER_UPGRADEABLE);
console.log(`V2 program:      ${V2_PROGRAM.toBase58()}`);
console.log(`V2 program-data: ${programData.toBase58()}`);
console.log(`Recipient (rent destination): ${LENDER.toBase58()}`);

// Read current rent balances
const progInfo = await conn.getAccountInfo(V2_PROGRAM);
const dataInfo = await conn.getAccountInfo(programData);
if (!progInfo) throw new Error("V2 program account not found — already closed?");
if (!dataInfo) throw new Error("V2 program-data account not found");
const progLamports = progInfo.lamports;
const dataLamports = dataInfo.lamports;
const totalRecoverable = progLamports + dataLamports;
console.log(`\nProgram account rent:      ${progLamports} lamports (${(progLamports/1e9).toFixed(9)} SOL)`);
console.log(`Program-data account rent: ${dataLamports} lamports (${(dataLamports/1e9).toFixed(6)} SOL)`);
console.log(`Total recoverable:         ${totalRecoverable} lamports (${(totalRecoverable/1e9).toFixed(6)} SOL)`);

// Verify upgrade authority
// Program-data layout: discriminator(4) + slot(8) + Option<UpgradeAuthority>(1+32)
const upgradeAuthByte = dataInfo.data.readUInt8(4 + 8);
if (upgradeAuthByte !== 1) throw new Error("Program-data has no upgrade authority — program is already immutable, cannot be closed");
const upgradeAuth = new PublicKey(dataInfo.data.slice(4 + 8 + 1, 4 + 8 + 1 + 32));
if (!upgradeAuth.equals(LENDER)) {
  throw new Error(`Upgrade authority mismatch: program expects ${upgradeAuth.toBase58()}, lender keypair is ${LENDER.toBase58()}`);
}
console.log(`Upgrade authority verified: ${upgradeAuth.toBase58()} (= lender) ✓`);

// Build the Close instruction.
// BPF Upgradeable Loader Close instruction variant index = 5.
// Accounts for closing a PROGRAM (not just program-data):
//   [0] program-data account (writable)
//   [1] recipient (writable) — gets the rent lamports
//   [2] upgrade authority (signer)
//   [3] program account (writable) — will be closed too
const closeIx = new TransactionInstruction({
  programId: BPF_LOADER_UPGRADEABLE,
  keys: [
    { pubkey: programData,  isSigner: false, isWritable: true  },
    { pubkey: LENDER,        isSigner: false, isWritable: true  },
    { pubkey: LENDER,        isSigner: true,  isWritable: false },
    { pubkey: V2_PROGRAM,    isSigner: false, isWritable: true  },
  ],
  data: Buffer.from([5, 0, 0, 0]), // u32 LE for instruction index
});

const tx = new Transaction();
tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
tx.add(closeIx);
tx.feePayer = LENDER;
tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
tx.sign(LENDER_KP);

// Simulate via raw RPC — the high-level conn.simulateTransaction has
// signature-shape quirks across web3.js versions; raw RPC is stable.
const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const simResp = await fetch(rpcUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "simulateTransaction",
    params: [tx.serialize().toString("base64"), { encoding: "base64", sigVerify: false, commitment: "confirmed" }],
  }),
});
const simJson = await simResp.json();
const sim = simJson.result?.value;
if (!sim) {
  console.log(`SIM RPC error: ${JSON.stringify(simJson.error || simJson).slice(0, 240)}`);
  throw new Error("simulate RPC failed — aborting");
}
if (sim.err) {
  console.log(`\nSIM FAILED: ${JSON.stringify(sim.err)}`);
  console.log("logs:\n" + (sim.logs || []).slice(-12).map(l => "  " + l).join("\n"));
  throw new Error("close simulation failed — aborting");
}
console.log(`\nSIM OK. units consumed=${sim.unitsConsumed ?? "?"}`);

if (DRY_RUN) {
  console.log(`\n[dry-run] would broadcast close tx; ${(totalRecoverable/1e9).toFixed(6)} SOL → ${LENDER.toBase58()}\n`);
  console.log("Re-run with --execute to broadcast.\n");
  process.exit(0);
}

console.log("\nBroadcasting close tx...");
const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
console.log(`Tx sig: ${sig}`);
console.log("Waiting for confirmation...");
const confirm = await conn.confirmTransaction(sig, "confirmed");
if (confirm.value.err) throw new Error(`confirm error: ${JSON.stringify(confirm.value.err)}`);

// Post-state verification
console.log("\n=== POST-CLOSE STATE ===");
const progAfter = await conn.getAccountInfo(V2_PROGRAM);
const dataAfter = await conn.getAccountInfo(programData);
console.log(`V2 program account:       ${progAfter ? `still exists (${progAfter.lamports} lamports)` : "GONE"}`);
console.log(`V2 program-data account:  ${dataAfter ? `still exists (${dataAfter.lamports} lamports)` : "GONE"}`);
const lenderAfter = await conn.getBalance(LENDER);
console.log(`Lender wallet SOL:        ${(lenderAfter/1e9).toFixed(6)}`);
console.log(`\nV2 program close: COMPLETE. ${(totalRecoverable/1e9).toFixed(6)} SOL recovered.`);
process.exit(0);
