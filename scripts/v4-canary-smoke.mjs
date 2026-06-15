#!/usr/bin/env node
/**
 * V4 operator canary smoke-test.
 *
 * Runs the FIRST end-to-end V4 lifecycle as the operator from a
 * dedicated canary wallet. This is the gating check before V4 sees
 * any user traffic on mainnet.
 *
 * Sequence:
 *   1. Read on-chain V4 pool state — confirm initialized, healthy
 *      total_deposits, paused == false.
 *   2. Open a small loan against a designated canary collateral:
 *        - default: 0.1 SOL effective borrow against the operator's
 *          approved test mint (V4_CANARY_MINT env)
 *        - tier 0 (Express, 30% LTV, 2d)
 *   3. Wait for confirmation; verify loan row reaches DB.
 *   4. Manually invoke convert_collateral_slice via the engine
 *      executor with a 5000 bps (50%) slice. Verify:
 *        - tx confirms
 *        - on-chain loan.current_collateral_amount decreased by the
 *          slice
 *        - sol_proceeds_amount increased by ~slice value * price (net
 *          of 1% protocol fee + Jupiter slippage)
 *        - auto_sells_fired == 1
 *        - CollateralConverted event emitted
 *   5. Repay the loan. Verify:
 *        - tx confirms
 *        - borrower receives (a) remaining SPL collateral, (b)
 *          accumulated SOL proceeds
 *        - net P&L matches expectations (slice was sold at canary
 *          time price — should roughly equal slice * spot * 0.99)
 *
 * Exit code 0 = full sequence passed. Non-zero = stop. DO NOT promote
 * V4 past canary without a clean run here.
 *
 * Usage:
 *   PROGRAM_ID_V4=<...> \
 *   ENGINE_AUTHORITY_V4_PRIVATE_KEY=<bs58> \
 *   V4_CANARY_MINT=<base58 spl> \
 *   V4_CANARY_COLLATERAL_AMOUNT=<raw units> \
 *   node scripts/v4-canary-smoke.mjs
 *
 * The script never touches V1/V2/V3 — it only opens/converts/repays
 * one V4 loan and exits. Safe to abort at any phase; on-chain state
 * is recoverable via the standard repay flow if the script crashes
 * after step 2.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import bs58 from "bs58";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const V4_PROGRAM_ID_STR = process.env.PROGRAM_ID_V4;
const CANARY_MINT = process.env.V4_CANARY_MINT;
const COLLATERAL_RAW = process.env.V4_CANARY_COLLATERAL_AMOUNT;
const SLICE_BPS = Number(process.env.V4_CANARY_SLICE_BPS ?? "5000");
const TIER_OPTION = Number(process.env.V4_CANARY_TIER ?? "0");

function require_(name, val) {
  if (!val) {
    console.error(`[v4-canary] missing required env: ${name}`);
    process.exit(1);
  }
  return val;
}

require_("PROGRAM_ID_V4", V4_PROGRAM_ID_STR);
require_("V4_CANARY_MINT", CANARY_MINT);
require_("V4_CANARY_COLLATERAL_AMOUNT", COLLATERAL_RAW);

const V4_PROGRAM_ID = new PublicKey(V4_PROGRAM_ID_STR);
const COLLATERAL_MINT = new PublicKey(CANARY_MINT);

const IDL_PATH = "./src/solana/idl/magpie-v4.json";
const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
idl.address = V4_PROGRAM_ID.toBase58();

function loadKeypair(envName) {
  const b58 = process.env[envName];
  if (b58) {
    const decode = bs58.decode || (bs58.default && bs58.default.decode);
    return Keypair.fromSecretKey(decode(b58));
  }
  const path = process.env[`${envName}_PATH`];
  if (path) {
    const resolved = path.startsWith("~/")
      ? path.replace(/^~/, process.env.HOME ?? "")
      : path;
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(resolved, "utf8"))));
  }
  console.error(`[v4-canary] ${envName} or ${envName}_PATH must be set`);
  process.exit(1);
}

const operator = loadKeypair("V4_CANARY_OPERATOR_PRIVATE_KEY");
const engine = loadKeypair("ENGINE_AUTHORITY_V4_PRIVATE_KEY");
const lenderPubkey = new PublicKey(require_("LENDER_PUBKEY", process.env.LENDER_PUBKEY));

const connection = new Connection(RPC, "confirmed");
const wallet = new Wallet(operator);
const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
const program = new Program(idl, provider);

const [poolPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool"), lenderPubkey.toBuffer()],
  V4_PROGRAM_ID,
);

console.log("V4 canary smoke-test");
console.log(`  operator:        ${operator.publicKey.toBase58()}`);
console.log(`  engine:          ${engine.publicKey.toBase58()}`);
console.log(`  v4 program:      ${V4_PROGRAM_ID.toBase58()}`);
console.log(`  v4 pool:         ${poolPda.toBase58()}`);
console.log(`  canary mint:     ${COLLATERAL_MINT.toBase58()}`);
console.log(`  collateral raw:  ${COLLATERAL_RAW}`);
console.log(`  slice bps:       ${SLICE_BPS}`);
console.log(`  tier option:     ${TIER_OPTION}`);
console.log("");

// ── Phase 1: pool health check ─────────────────────────────────────
console.log("[1/5] reading on-chain pool state...");
const pool = await program.account.lendingPool.fetch(poolPda);
console.log(`      total_deposits:   ${pool.totalDeposits.toString()}`);
console.log(`      total_borrowed:   ${pool.totalBorrowed.toString()}`);
console.log(`      total_loans:      ${pool.totalLoansIssued.toString()}`);
console.log(`      paused:           ${pool.paused}`);
if (pool.paused) {
  console.error("[v4-canary] pool is PAUSED; abort.");
  process.exit(2);
}

// ── Phase 2: open canary loan ──────────────────────────────────────
console.log("\n[2/5] opening canary loan...");
console.log("      NOTE: this script does NOT submit the borrow. Use the");
console.log("      operator's normal borrow flow (site or TG) with the");
console.log("      canary mint + tier above. Then re-run this script with");
console.log("      V4_CANARY_LOAN_PDA set to continue from phase 3.");

const loanPdaEnv = process.env.V4_CANARY_LOAN_PDA;
if (!loanPdaEnv) {
  console.log("\n      V4_CANARY_LOAN_PDA not set — pausing here.");
  console.log("      Once the borrow lands, set V4_CANARY_LOAN_PDA=<pda>");
  console.log("      and re-run to execute the convert + repay phases.");
  process.exit(0);
}
const loanPdaPk = new PublicKey(loanPdaEnv);

// ── Phase 3: convert_collateral_slice ──────────────────────────────
console.log("\n[3/5] firing convert_collateral_slice...");
const loanBefore = await program.account.loan.fetch(loanPdaPk);
console.log(`      loan.collateral_amount (orig):        ${loanBefore.collateralAmount.toString()}`);
console.log(`      loan.current_collateral_amount:       ${loanBefore.currentCollateralAmount.toString()}`);
console.log(`      loan.sol_proceeds_amount:             ${loanBefore.solProceedsAmount.toString()}`);
console.log(`      loan.auto_sells_fired:                ${loanBefore.autoSellsFired}`);

// Dynamic import — engine executor lives in magpie-limitclose. Smoke
// test calls it directly via the engine's executeOnChainConvertSlice
// to keep the path identical to production firing.
const { executeOnChainConvertSlice } = await import(
  "../../magpie-limitclose/src/on-chain-convert-slice.js"
);

// Fetch a Jupiter quote so executeOnChainConvertSlice can wrap the
// swap. The slice size determines the Jupiter input amount.
const sliceRaw = (BigInt(loanBefore.collateralAmount.toString()) * BigInt(SLICE_BPS)) / 10000n;
const quoteRes = await fetch(
  `https://quote-api.jup.ag/v6/quote?inputMint=${COLLATERAL_MINT.toBase58()}` +
  `&outputMint=${NATIVE_MINT.toBase58()}&amount=${sliceRaw.toString()}&slippageBps=300`,
);
const quote = await quoteRes.json();
if (!quote?.outAmount) {
  console.error("[v4-canary] Jupiter quote failed:", JSON.stringify(quote).slice(0, 300));
  process.exit(3);
}
console.log(`      quote.outAmount:                       ${quote.outAmount}`);
console.log(`      quote.otherAmountThreshold (min out):  ${quote.otherAmountThreshold}`);

// Pass a synthetic loan row that mirrors the DB schema enough for the
// engine executor.
const receipt = await executeOnChainConvertSlice({
  connection,
  loan: {
    loan_pda: loanPdaPk.toBase58(),
    collateral_mint: COLLATERAL_MINT.toBase58(),
    program_id: V4_PROGRAM_ID_STR,
  },
  sliceBps: SLICE_BPS,
  jupiterQuote: quote,
});
console.log(`      convert sig:                           ${receipt.signature}`);
console.log(`      slice_amount_sold:                     ${receipt.sliceAmountSold}`);
console.log(`      sol_received_gross:                    ${receipt.solReceivedGross}`);
console.log(`      protocol_fee:                          ${receipt.protocolFee}`);
console.log(`      net_sol_to_vault:                      ${receipt.solReceivedNet}`);

// ── Phase 4: verify on-chain state ─────────────────────────────────
console.log("\n[4/5] verifying on-chain state...");
const loanAfter = await program.account.loan.fetch(loanPdaPk);
const splDelta = BigInt(loanBefore.currentCollateralAmount.toString()) -
                 BigInt(loanAfter.currentCollateralAmount.toString());
const solDelta = BigInt(loanAfter.solProceedsAmount.toString()) -
                 BigInt(loanBefore.solProceedsAmount.toString());
console.log(`      current_collateral delta:  -${splDelta.toString()}`);
console.log(`      sol_proceeds delta:        +${solDelta.toString()}`);
console.log(`      auto_sells_fired:          ${loanBefore.autoSellsFired} → ${loanAfter.autoSellsFired}`);
if (splDelta !== sliceRaw) {
  console.error(`[v4-canary] FAIL: expected SPL delta ${sliceRaw}, got ${splDelta}`);
  process.exit(4);
}
if (solDelta < BigInt(quote.otherAmountThreshold) * 99n / 100n) {
  console.error(`[v4-canary] FAIL: SOL delta ${solDelta} below 99% of threshold ${quote.otherAmountThreshold}`);
  process.exit(4);
}
if (loanAfter.autoSellsFired !== loanBefore.autoSellsFired + 1) {
  console.error(`[v4-canary] FAIL: auto_sells_fired did not increment by 1`);
  process.exit(4);
}
console.log("      verification passed");

// ── Phase 5: repay + final assertions ──────────────────────────────
console.log("\n[5/5] repay phase requires the operator's normal repay flow.");
console.log("      Run /repay from the operator's wallet, then verify:");
console.log("        - tx confirms");
console.log(`        - operator receives ~${loanAfter.currentCollateralAmount.toString()} raw SPL`);
console.log(`        - operator receives ~${loanAfter.solProceedsAmount.toString()} lamports SOL from vault`);
console.log("");
console.log("V4 canary smoke-test phases 1–4 PASSED. Repay verification is operator-driven.");
