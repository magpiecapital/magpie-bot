#!/usr/bin/env node
/**
 * End-to-end simulation test for RWA collateral borrows.
 *
 * For every enabled stock/etf in the DB:
 *   1. Inspects the on-chain mint (program, decimals, Token-2022 extensions)
 *   2. Runs the bot's pricing path (collateralValueLamports) to get a SOL quote
 *   3. Finds a real holder of that token on-chain via getTokenLargestAccounts
 *   4. Builds the exact borrow tx the production site would build
 *   5. Runs simulateTransaction with sigVerify=false against mainnet
 *   6. Reports PASS / FAIL per token + per-step diagnostic
 *
 * No SOL is spent — simulateTransaction executes the on-chain program in
 * a sandbox, but no state is committed. If simulation says PASS, the real
 * tx will succeed (modulo blockhash freshness and balance changes).
 *
 * Usage:
 *   railway run node scripts/test-rwa-borrow.js
 *   railway run node scripts/test-rwa-borrow.js --symbol NVDAx   # one token
 */
import "dotenv/config";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getMint,
  getScaledUiAmountConfig,
  getExtensionTypes,
  ExtensionType,
} from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";
const { BN } = anchor;
import { query } from "../src/db/pool.js";
import { connection } from "../src/solana/connection.js";
import { getReadOnlyProgram } from "../src/solana/program.js";
import {
  lendingPoolPda,
  loanTokenVaultPda,
  loanPda,
  collateralVaultPda,
  priceFeedPda,
} from "../src/solana/pdas.js";
import { collateralValueLamports } from "../src/services/price.js";

const LENDER_PUBKEY = new PublicKey(process.env.LENDER_PUBKEY);
const onlySymbol = process.argv.find((a) => a.startsWith("--symbol="))?.split("=")[1]
  ?? (process.argv.includes("--symbol") ? process.argv[process.argv.indexOf("--symbol") + 1] : null);

async function detectTokenProgram(mintPk) {
  const info = await connection.getAccountInfo(mintPk);
  if (!info) throw new Error("Mint not found");
  return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

async function findRealHolder(mintPk) {
  const largest = await connection.getTokenLargestAccounts(mintPk);
  if (!largest.value || largest.value.length === 0) return null;

  for (const entry of largest.value) {
    if (entry.uiAmount == null || entry.uiAmount <= 0) continue;
    const acctInfo = await connection.getParsedAccountInfo(entry.address);
    const data = acctInfo.value?.data;
    if (!data || !("parsed" in data)) continue;
    const ownerStr = data.parsed.info?.owner;
    if (!ownerStr) continue;
    if (ownerStr === LENDER_PUBKEY.toBase58()) continue;
    // Skip PDAs (off-curve): borrower must be a real wallet that can sign.
    // Most top holders by balance are DEX pool PDAs — keep walking until
    // we hit an actual user wallet.
    const ownerPk = new PublicKey(ownerStr);
    if (!PublicKey.isOnCurve(ownerPk.toBuffer())) continue;
    return {
      owner: ownerPk,
      ata: entry.address,
      rawBalance: BigInt(entry.amount),
      uiBalance: entry.uiAmount,
    };
  }
  return null;
}

async function buildBorrowTx({
  borrower,
  collateralMint,
  collateralProgram,
  collateralAmountRaw,
  collateralValueLamportsBN,
}) {
  const collateralMintPk = new PublicKey(collateralMint);
  const loanTokenMintPk = NATIVE_MINT;

  const [pool] = lendingPoolPda(LENDER_PUBKEY);
  const [loanTokenVault] = loanTokenVaultPda(pool);
  const [priceFeed] = priceFeedPda(collateralMintPk, pool);

  const loanId = new BN(Date.now());
  const [loanAccount] = loanPda(borrower, loanId);
  const [collateralVault] = collateralVaultPda(loanAccount);

  const borrowerCollateralAta = getAssociatedTokenAddressSync(
    collateralMintPk, borrower, false, collateralProgram,
  );
  const borrowerWsolAta = getAssociatedTokenAddressSync(
    loanTokenMintPk, borrower, false, TOKEN_PROGRAM_ID,
  );
  const feeWalletWsolAta = getAssociatedTokenAddressSync(
    loanTokenMintPk, LENDER_PUBKEY, false, TOKEN_PROGRAM_ID,
  );

  const program = getReadOnlyProgram();

  const preIxs = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      borrower, borrowerWsolAta, borrower, loanTokenMintPk, TOKEN_PROGRAM_ID,
    ),
  ];
  const postIxs = [
    createCloseAccountInstruction(
      borrowerWsolAta, borrower, borrower, [], TOKEN_PROGRAM_ID,
    ),
  ];

  const tx = await program.methods
    .requestAndFundLoan(
      new BN(collateralAmountRaw.toString()),
      0, // Express tier — fastest, cheapest
      collateralValueLamportsBN,
      loanId,
    )
    .accounts({
      pool,
      loanTokenVault,
      loan: loanAccount,
      collateralVault,
      collateralMint: collateralMintPk,
      borrowerCollateralAccount: borrowerCollateralAta,
      borrowerLoanTokenAccount: borrowerWsolAta,
      feeWalletTokenAccount: feeWalletWsolAta,
      borrower,
      authority: LENDER_PUBKEY,
      priceFeed,
      systemProgram: SystemProgram.programId,
      tokenProgram: collateralProgram,
      loanTokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .preInstructions(preIxs)
    .postInstructions(postIxs)
    .transaction();

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = borrower;

  return { tx, loanAccount, collateralVault };
}

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(6);
}

async function testOne(token) {
  const { symbol, mint, decimals } = token;
  console.log(`\n══════ ${symbol} (${mint.slice(0, 16)}…) ══════`);

  const mintPk = new PublicKey(mint);

  // 1. Mint inspection
  let collateralProgram, mintData, extensions, scaling;
  try {
    collateralProgram = await detectTokenProgram(mintPk);
    const isT22 = collateralProgram.equals(TOKEN_2022_PROGRAM_ID);
    mintData = await getMint(connection, mintPk, "confirmed", collateralProgram);
    extensions = isT22 ? getExtensionTypes(mintData.tlvData).map((t) => ExtensionType[t] ?? `unknown(${t})`) : [];
    scaling = isT22 ? getScaledUiAmountConfig(mintData) : null;
    console.log(`  [1] Mint: ${isT22 ? "Token-2022" : "classic"}, decimals=${mintData.decimals}, supply=${mintData.supply.toString()}`);
    if (extensions.length) console.log(`      Extensions: ${extensions.join(", ")}`);
    if (scaling) console.log(`      ScaledUiAmount multiplier: ${scaling.multiplier}`);
  } catch (e) {
    console.log(`  [1] ✗ Mint inspection failed: ${e.message}`);
    return { symbol, status: "FAIL", step: "mint_inspect", reason: e.message };
  }

  // 2. Pricing
  let priceSol, valueLamports;
  try {
    // Quote for 1 whole token to get a sense of price
    const oneToken = BigInt(10) ** BigInt(mintData.decimals);
    valueLamports = await collateralValueLamports(mint, oneToken.toString(), mintData.decimals);
    priceSol = valueLamports / 1e9;
    console.log(`  [2] Price: 1 ${symbol} = ${priceSol.toFixed(6)} SOL`);
  } catch (e) {
    console.log(`  [2] ✗ Pricing failed: ${e.message}`);
    return { symbol, status: "FAIL", step: "pricing", reason: e.message };
  }

  // 3. Find a real holder
  let holder;
  try {
    holder = await findRealHolder(mintPk);
    if (!holder) {
      console.log(`  [3] ✗ No holders found (besides lender wallet)`);
      return { symbol, status: "SKIP", step: "find_holder", reason: "no real holders" };
    }
    console.log(`  [3] Holder: ${holder.owner.toBase58().slice(0, 12)}… has ${holder.uiBalance} ${symbol}`);
  } catch (e) {
    console.log(`  [3] ✗ Holder lookup failed: ${e.message}`);
    return { symbol, status: "FAIL", step: "find_holder", reason: e.message };
  }

  // 3b. Verify price_feed exists for this mint (precondition for borrow).
  try {
    const [pool] = lendingPoolPda(LENDER_PUBKEY);
    const [pf] = priceFeedPda(mintPk, pool);
    const pfInfo = await connection.getAccountInfo(pf);
    if (!pfInfo) {
      console.log(`  [3b] ✗ price_feed not initialized on-chain — waiting on price-attestor`);
      return { symbol, status: "PENDING", step: "price_feed", reason: "feed not initialized" };
    }
    console.log(`  [3b] price_feed exists (${pfInfo.data.length}b)`);
  } catch (e) {
    console.log(`  [3b] ✗ price_feed check failed: ${e.message}`);
    return { symbol, status: "FAIL", step: "price_feed", reason: e.message };
  }

  // 4. Build borrow tx using a small fraction of holder's balance.
  //    Pick deposit_raw so that valueLamports is at least 1_000_000 (0.001 SOL)
  //    to clear any minimum-loan thresholds the program enforces.
  let tx;
  try {
    // Aim for ~0.1 SOL collateral value, but cap at what holder actually has
    const targetSolValue = 0.1;
    const tokensNeeded = targetSolValue / priceSol;
    const rawTokens = BigInt(Math.floor(tokensNeeded * 10 ** mintData.decimals));
    const depositRaw = rawTokens > holder.rawBalance / 100n ? holder.rawBalance / 100n : rawTokens;
    if (depositRaw <= 0n) {
      console.log(`  [4] ✗ Computed deposit is 0`);
      return { symbol, status: "FAIL", step: "build_tx", reason: "deposit zero" };
    }
    const depositValueLamports = await collateralValueLamports(
      mint, depositRaw.toString(), mintData.decimals,
    );
    const result = await buildBorrowTx({
      borrower: holder.owner,
      collateralMint: mint,
      collateralProgram,
      collateralAmountRaw: depositRaw,
      collateralValueLamportsBN: new BN(depositValueLamports.toString()),
    });
    tx = result.tx;
    console.log(`  [4] Built tx: deposit=${(Number(depositRaw) / 10 ** mintData.decimals).toFixed(6)} ${symbol} worth ${fmtSol(depositValueLamports)} SOL`);
  } catch (e) {
    console.log(`  [4] ✗ Tx build failed: ${e.message}`);
    console.log(e.stack);
    return { symbol, status: "FAIL", step: "build_tx", reason: e.message };
  }

  // 5. Simulate on mainnet
  try {
    const sim = await connection.simulateTransaction(tx, undefined, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    });
    if (sim.value.err) {
      // Some errors are EXPECTED in a synthetic simulation:
      //   - InsufficientFunds for SOL: borrower can't pay rent for accounts
      //     they don't normally own (vault creation, etc.)
      //   - Account in use: blockhash collisions
      // Capture the actual program log lines so we can tell what failed.
      const errStr = JSON.stringify(sim.value.err);
      const logs = sim.value.logs || [];
      console.log(`  [5] ✗ Simulation err: ${errStr}`);
      console.log(`      Logs (last 8):`);
      for (const ln of logs.slice(-8)) console.log(`        ${ln}`);
      return { symbol, status: "FAIL", step: "simulate", reason: errStr, logs };
    }
    console.log(`  [5] ✓ Simulation succeeded — borrow path works for ${symbol}`);
    const cuLog = (sim.value.logs || []).find((l) => l.includes("consumed"));
    if (cuLog) console.log(`      ${cuLog.trim()}`);
    return { symbol, status: "PASS", step: "simulate" };
  } catch (e) {
    console.log(`  [5] ✗ Simulation exception: ${e.message}`);
    return { symbol, status: "FAIL", step: "simulate", reason: e.message };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// If user passed --symbol, allow ANY enabled mint (so we can run a memecoin
// control). Otherwise default to RWA only.
const sql = onlySymbol
  ? `SELECT mint, symbol, decimals FROM supported_mints WHERE symbol = $1 AND enabled = TRUE`
  : `SELECT mint, symbol, decimals FROM supported_mints WHERE category IN ('stock','etf','metal') AND enabled = TRUE ORDER BY category, symbol`;
const { rows } = await query(sql, onlySymbol ? [onlySymbol] : []);
const targets = rows;

if (targets.length === 0) {
  console.log(onlySymbol ? `No enabled RWA with symbol=${onlySymbol}` : "No enabled RWA tokens");
  process.exit(1);
}

console.log(`Testing ${targets.length} RWA token${targets.length === 1 ? "" : "s"} via simulateTransaction (no SOL spent)`);
console.log(`Lender: ${LENDER_PUBKEY.toBase58()}\n`);

const results = [];
for (const t of targets) {
  try {
    results.push(await testOne(t));
  } catch (e) {
    console.log(`\n[${t.symbol}] EXCEPTION: ${e.message}`);
    results.push({ symbol: t.symbol, status: "FAIL", step: "exception", reason: e.message });
  }
}

console.log("\n═══ Summary ═══");
const pass = results.filter((r) => r.status === "PASS");
const fail = results.filter((r) => r.status === "FAIL");
const skip = results.filter((r) => r.status === "SKIP");
console.log(`  PASS:  ${pass.map((r) => r.symbol).join(", ") || "(none)"}`);
console.log(`  SKIP:  ${skip.map((r) => `${r.symbol} (${r.reason})`).join(", ") || "(none)"}`);
console.log(`  FAIL:  ${fail.map((r) => `${r.symbol} @${r.step}: ${r.reason?.slice(0, 60)}`).join(", ") || "(none)"}`);

process.exit(fail.length === 0 ? 0 : 1);
