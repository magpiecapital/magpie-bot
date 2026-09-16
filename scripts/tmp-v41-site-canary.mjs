// Site-shaped V4.1 lifecycle canary: builds txs EXACTLY like magpie-site does,
// signs with the canary wallet only, and (for borrow) POSTs to the public
// /api/v1/cosign-borrow — the same path a website borrower takes.
import fs from "node:fs"; import path from "node:path";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, ComputeBudgetProgram } from "@solana/web3.js";
import BN from "bn.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createCloseAccountInstruction } from "@solana/spl-token";
import { connection } from "../src/solana/connection.js";
import { lendingPoolPda, loanTokenVaultPda, loanPda, collateralVaultPda, priceFeedPda } from "../src/solana/pdas.js";
import { query } from "../src/db/pool.js";

const PHASE = process.argv[2]; const EXECUTE = process.argv.includes("--execute");
const BOT = "https://magpie-bot-production.up.railway.app";
const V41 = new PublicKey(process.env.PROGRAM_ID_V4_1); const LENDER = new PublicKey(process.env.LENDER_PUBKEY);
const MINT = new PublicKey("J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump"); const DEC = 6; // TRIPLET (Token-2022)
const STATE_F = path.join(process.env.HOME, ".magpie-private/v41-site-canary-state.json");
const state = fs.existsSync(STATE_F) ? JSON.parse(fs.readFileSync(STATE_F)) : {};
const save = () => fs.writeFileSync(STATE_F, JSON.stringify(state, null, 1));
const canary = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".magpie-private/v41-canary-keypair.json")))));
const idl = JSON.parse(fs.readFileSync("src/solana/idl/magpie-v4-1.json"));
const program = new Program({ ...idl, address: V41.toBase58() }, new AnchorProvider(connection, new Wallet(canary), { commitment: "confirmed" }));
const [pool] = lendingPoolPda(LENDER, V41); const [loanTokenVault] = loanTokenVaultPda(pool, V41); const [priceFeed] = priceFeedPda(MINT, pool, V41);
const bColl = getAssociatedTokenAddressSync(MINT, canary.publicKey, false, TOKEN_2022_PROGRAM_ID);
const bWsol = getAssociatedTokenAddressSync(NATIVE_MINT, canary.publicKey, false, TOKEN_PROGRAM_ID);
const feeWsol = getAssociatedTokenAddressSync(NATIVE_MINT, LENDER, false, TOKEN_PROGRAM_ID);
console.log(`canary ${canary.publicKey.toBase58()} | V4.1 ${V41.toBase58()} | pool ${pool.toBase58()} | feeWsol ${feeWsol.toBase58()}`);

async function warm() {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${BOT}/api/v1/v4/feed-ready?mint=${MINT}`).then(r => r.json());
    if (r.ready) { if (r.program !== V41.toBase58()) throw new Error("feed-ready resolved program " + r.program + " — NOT V4.1"); console.log("feed ready on V4.1", r.samples_in_window, "samples"); return; }
    console.log("warming:", r.reason, r.samples_in_window ?? "", r.eta_seconds ?? ""); await new Promise(r => setTimeout(r, 6000));
  }
  throw new Error("feed never warmed");
}
async function send(tx, label) {
  tx.feePayer = canary.publicKey; const bh = await connection.getLatestBlockhash("confirmed"); tx.recentBlockhash = bh.blockhash;
  const sim = await connection.simulateTransaction(tx, [canary]);
  if (sim.value.err) { console.log(label, "SIM ERR", JSON.stringify(sim.value.err)); console.log((sim.value.logs || []).slice(-8).join("\n")); throw new Error(label + " simulation failed"); }
  console.log(label, "sim OK, CU", sim.value.unitsConsumed);
  if (!EXECUTE) { console.log("[dry-run] not sending"); return null; }
  tx.sign(canary); const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed"); console.log(label, "CONFIRMED", sig); return sig;
}

if (PHASE === "borrow") {
  await warm();
  const bal = await connection.getTokenAccountBalance(bColl); const amountRaw = BigInt(bal.value.amount); console.log("collateral raw", amountRaw.toString());
  const sc = await fetch(`${BOT}/api/v1/safe-collateral-value?mint=${MINT}&decimals=${DEC}&amount_raw=${amountRaw}&program=v41`).then(r => r.json());
  console.log("safe-collateral-value:", sc.recommendation, sc.safe_collateral_value_sol, sc.reason ?? "");
  let valueLamports;
  if (sc.recommendation === "use_precise_value") valueLamports = BigInt(sc.safe_collateral_value_lamports);
  else {
    // Site V4 lane behaviour: value from the live feed, cosign caps it. Read the
    // V4.1 PriceHistory ring buffer (1800s chain window), TWAP × 0.97 headroom.
    const info = await connection.getAccountInfo(priceFeed); const head = info.data.readUInt8(104), count = info.data.readUInt8(105);
    const now = BigInt(Math.floor(Date.now() / 1000)); let sum = 0n, n = 0n;
    for (let i = 0; i < Math.min(count, 32); i++) { const idx = (head - 1 - i + 32) % 32; const st = 112 + idx * 16; const ts = info.data.readBigInt64LE(st + 8); if (ts >= now - 1800n) { sum += info.data.readBigUInt64LE(st); n++; } }
    const twap = sum / n; valueLamports = (amountRaw * twap * 97n) / (10n ** BigInt(DEC) * 100n);
    console.log(`on-chain V4.1 TWAP ${twap} lamports/token over ${n} samples → value ${valueLamports} lamports (${Number(valueLamports)/1e9} SOL)`);
  }
  const collateralValue = new BN(valueLamports.toString());
  const loanId = new BN(Date.now()).muln(0x10000).addn(Math.floor(Math.random() * 0x10000));
  const [loanAcct] = loanPda(canary.publicKey, loanId, V41); const [collateralVault] = collateralVaultPda(loanAcct, V41);
  const pre = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }),
    createAssociatedTokenAccountIdempotentInstruction(canary.publicKey, bWsol, canary.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(canary.publicKey, bColl, canary.publicKey, MINT, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(canary.publicKey, feeWsol, LENDER, NATIVE_MINT, TOKEN_PROGRAM_ID)];
  const post = [createCloseAccountInstruction(bWsol, canary.publicKey, canary.publicKey, [], TOKEN_PROGRAM_ID)];
  const tx = await program.methods.requestAndFundLoan(new BN(amountRaw.toString()), 2, collateralValue, loanId, 0)
    .accounts({ pool, loanTokenVault, loan: loanAcct, collateralVault, collateralMint: MINT, borrowerCollateralAccount: bColl, borrowerLoanTokenAccount: bWsol, feeWalletTokenAccount: feeWsol, borrower: canary.publicKey, authority: LENDER, priceFeed, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_2022_PROGRAM_ID, loanTokenProgram: TOKEN_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY })
    .preInstructions(pre).postInstructions(post).transaction();
  tx.feePayer = canary.publicKey; const bh = await connection.getLatestBlockhash("confirmed"); tx.recentBlockhash = bh.blockhash;
  tx.partialSign(canary);
  const b64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  console.log(`borrow tx built: loanId ${loanId} loanPda ${loanAcct.toBase58()} value ${collateralValue.toString()} lamports, option 2 (20%/7d)`);
  if (!EXECUTE) { console.log("[dry-run] would POST to /api/v1/cosign-borrow (" + b64.length + " b64 chars)"); process.exit(0); }
  let body;
  for (let attempt = 1; attempt <= 5; attempt++) {
    // rebuild with a fresh blockhash each attempt (same loanId)
    const bh2 = await connection.getLatestBlockhash("confirmed"); tx.recentBlockhash = bh2.blockhash; tx.signatures = []; tx.partialSign(canary);
    const b64a = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    const res = await fetch(`${BOT}/api/v1/cosign-borrow`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ partialSignedTxBase64: b64a }), signal: AbortSignal.timeout(120_000) });
    body = await res.json().catch(() => ({})); console.log(`cosign-borrow attempt ${attempt}:`, res.status, JSON.stringify(body).slice(0, 300));
    if (body.ok) break;
    if (body.oracle_warming) { const w = (body.retry_after_seconds || 25) * 1000 + 3000; console.log(`oracle warming — retrying in ${w/1000}s (site shows "tap Borrow again")`); await new Promise(r => setTimeout(r, w)); continue; }
    process.exit(1);
  }
  if (!body?.ok) process.exit(1);
  state.loanPda = body.loan_pda || loanAcct.toBase58(); state.loanId = loanId.toString(); state.borrowSig = body.signature; save();
  await new Promise(r => setTimeout(r, 4000));
  const { rows } = await query(`select id, program_id, status, loan_amount_lamports, due_timestamp from loans where loan_pda = $1`, [state.loanPda]);
  console.log("DB row:", rows[0]); process.exit(0);
}

if (PHASE === "extend") {
  if (!state.loanPda) throw new Error("no loan in state"); const loanPk = new PublicKey(state.loanPda);
  await warm();
  const live = await program.account.loan.fetch(loanPk); const owed = BigInt(live.repayAmount.toString()); const ltv = Number(live.ltvPercentage ?? (live.ltvBps != null ? Number(live.ltvBps) / 100 : 0));
  const feeBps = 300n; /* over-wrap like the site; close-account refunds the remainder */ const fee = owed * feeBps / 10000n;
  console.log("owed", owed.toString(), "ltv", ltv, "extend fee", fee.toString(), "due before", Number(live.dueTimestamp));
  const pre = [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }),
    createAssociatedTokenAccountIdempotentInstruction(canary.publicKey, bWsol, canary.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(canary.publicKey, feeWsol, LENDER, NATIVE_MINT, TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: canary.publicKey, toPubkey: bWsol, lamports: fee }), createSyncNativeInstruction(bWsol, TOKEN_PROGRAM_ID)];
  const post = [createCloseAccountInstruction(bWsol, canary.publicKey, canary.publicKey, [], TOKEN_PROGRAM_ID)];
  const tx = await program.methods.extendLoan().accounts({ pool, loanTokenVault, loan: loanPk, borrowerLoanTokenAccount: bWsol, feeWalletTokenAccount: feeWsol, borrower: canary.publicKey, loanTokenProgram: TOKEN_PROGRAM_ID, collateralMint: MINT, priceHistory: priceFeed, authority: null /* omit optional signer explicitly — Anchor otherwise auto-fills the provider wallet */ })
    .preInstructions(pre).postInstructions(post).transaction();
  const sig = await send(tx, "extend"); if (!sig) process.exit(0);
  await fetch(`${BOT}/api/v1/sync-loan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loan_pda: state.loanPda, signature: sig }) }).catch(() => {});
  const after = await program.account.loan.fetch(loanPk); console.log("due after", Number(after.dueTimestamp), "delta days", (Number(after.dueTimestamp) - Number(live.dueTimestamp)) / 86400);
  state.extendSig = sig; save(); process.exit(0);
}

if (PHASE === "partialrepay") {
  const loanPk = new PublicKey(state.loanPda); const amt = BigInt(process.argv[3] || "2000000");
  const pre = [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }),
    createAssociatedTokenAccountIdempotentInstruction(canary.publicKey, bWsol, canary.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: canary.publicKey, toPubkey: bWsol, lamports: amt }), createSyncNativeInstruction(bWsol, TOKEN_PROGRAM_ID)];
  const post = [createCloseAccountInstruction(bWsol, canary.publicKey, canary.publicKey, [], TOKEN_PROGRAM_ID)];
  const tx = await program.methods.partialRepay(new BN(amt.toString())).accounts({ pool, loanTokenVault, loan: loanPk, borrowerLoanTokenAccount: bWsol, borrower: canary.publicKey, loanTokenProgram: TOKEN_PROGRAM_ID }).preInstructions(pre).postInstructions(post).transaction();
  const sig = await send(tx, "partial-repay"); if (!sig) process.exit(0);
  const after = await program.account.loan.fetch(loanPk); console.log("repayAmount after", after.repayAmount.toString()); state.partialSig = sig; save(); process.exit(0);
}

if (PHASE === "repay") {
  if (!state.loanPda) throw new Error("no loan in state"); const loanPk = new PublicKey(state.loanPda);
  const live = await program.account.loan.fetch(loanPk); const repay = BigInt(live.repayAmount.toString()); console.log("repay lamports", repay.toString());
  const [collateralVault] = collateralVaultPda(loanPk, V41);
  const [solProceedsVault] = PublicKey.findProgramAddressSync([Buffer.from("sol-proceeds"), loanPk.toBuffer()], V41);
  const pre = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }),
    createAssociatedTokenAccountIdempotentInstruction(canary.publicKey, bColl, canary.publicKey, MINT, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(canary.publicKey, bWsol, canary.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: canary.publicKey, toPubkey: bWsol, lamports: repay }), createSyncNativeInstruction(bWsol, TOKEN_PROGRAM_ID)];
  const post = [createCloseAccountInstruction(bWsol, canary.publicKey, canary.publicKey, [], TOKEN_PROGRAM_ID)];
  const tx = await program.methods.repayLoan().accounts({ pool, loanTokenVault, loan: loanPk, collateralMint: MINT, collateralVault, borrowerCollateralAccount: bColl, borrowerLoanTokenAccount: bWsol, borrower: canary.publicKey, solProceedsVault, wsolMint: NATIVE_MINT, tokenProgram: TOKEN_2022_PROGRAM_ID, loanTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY })
    .preInstructions(pre).postInstructions(post).transaction();
  const sig = await send(tx, "repay"); if (!sig) process.exit(0);
  await fetch(`${BOT}/api/v1/sync-loan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loan_pda: state.loanPda, signature: sig }) }).catch(() => {});
  const gone = await connection.getAccountInfo(loanPk); const bal = await connection.getTokenAccountBalance(bColl);
  console.log("loan account:", gone ? "still exists" : "CLOSED", "| TRIPLET back:", bal.value.uiAmountString);
  state.repaySig = sig; save(); process.exit(0);
}
console.log("usage: borrow|extend|repay [--execute]");
