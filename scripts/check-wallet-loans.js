#!/usr/bin/env node
/**
 * Check a wallet's full state in the protocol:
 *   - Active / past loans (on-chain, by borrower pubkey)
 *   - Current SOL balance
 *   - Current SPL token balances (legacy + Token-2022)
 *
 * Pure read-only. No signing. No DB access required.
 *
 * Usage:
 *   node scripts/check-wallet-loans.js <pubkey>
 *
 * Example:
 *   node scripts/check-wallet-loans.js 2FGSXjT4TavT2YKmZbXXmrCtpF7C1ouKhbgvqTGNyakK
 */
import "dotenv/config";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { connection } from "../src/solana/connection.js";
import { getReadOnlyProgram, PROGRAM_ID } from "../src/solana/program.js";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/check-wallet-loans.js <pubkey>");
  process.exit(1);
}

let targetPk;
try {
  targetPk = new PublicKey(target);
} catch {
  console.error(`Invalid pubkey: ${target}`);
  process.exit(1);
}

async function main() {
  console.log("═══════════ Wallet Protocol State ═══════════");
  console.log(`Wallet:     ${targetPk.toBase58()}`);
  console.log(`Program:    ${PROGRAM_ID.toBase58()}\n`);

  // ── 1. SOL balance ──
  const lamports = await connection.getBalance(targetPk, "confirmed");
  const sol = lamports / LAMPORTS_PER_SOL;
  console.log(`SOL balance:           ${sol.toFixed(6)} SOL  (${lamports.toLocaleString()} lamports)`);

  // ── 2. SPL token balances (legacy + Token-2022) ──
  let tokenLines = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const accts = await connection.getParsedTokenAccountsByOwner(targetPk, { programId });
    for (const a of accts.value) {
      const info = a.account.data.parsed.info;
      const ui = info.tokenAmount.uiAmount;
      if (ui && ui > 0) {
        tokenLines.push({
          mint: info.mint,
          amount: ui,
          raw: info.tokenAmount.amount,
          decimals: info.tokenAmount.decimals,
          program: programId.equals(TOKEN_2022_PROGRAM_ID) ? "Token-2022" : "SPL",
        });
      }
    }
  }
  if (tokenLines.length === 0) {
    console.log(`SPL tokens:            (none)`);
  } else {
    console.log(`SPL tokens:`);
    tokenLines.forEach((t) => {
      console.log(`  • ${t.amount} (raw=${t.raw}, dec=${t.decimals}, ${t.program})  mint=${t.mint}`);
    });
  }
  console.log();

  // ── 3. Loan accounts where borrower = target ──
  // Anchor stores `borrower` as a Pubkey field on the Loan struct. We
  // can filter program accounts by memcmp on the borrower offset, but
  // simpler/safer is to fetch all loans and filter client-side. At
  // current scale (~120 loans) this is cheap.
  console.log(`Loan accounts (borrower = ${targetPk.toBase58().slice(0, 8)}...):`);
  const program = getReadOnlyProgram();
  let loans = [];
  try {
    loans = await program.account.loan.all([
      {
        memcmp: {
          // The `borrower` Pubkey is at a known offset in the Loan struct.
          // 8 (discriminator) + 32 (lender) = 40. If the IDL changes the
          // struct ordering, this offset needs updating. As a fallback,
          // remove the filter and we'll get all loans, then filter
          // client-side below.
          offset: 8 + 32,
          bytes: targetPk.toBase58(),
        },
      },
    ]);
  } catch (err) {
    console.warn(`  (memcmp filter failed: ${err.message}; falling back to scan)`);
    const all = await program.account.loan.all();
    loans = all.filter((l) => l.account.borrower?.equals(targetPk));
  }

  if (loans.length === 0) {
    console.log(`  ✓ NONE — this wallet has no loans in the protocol.\n`);
  } else {
    console.log(`  Found ${loans.length} loan account(s):\n`);
    for (const l of loans) {
      const a = l.account;
      const collateralUi = a.collateralAmount ? a.collateralAmount.toString() : "?";
      const debt = a.amountOwed ? a.amountOwed.toString() : "?";
      const status = a.status ? Object.keys(a.status)[0] : "?";
      const due = a.dueTimestamp ? new Date(a.dueTimestamp.toNumber() * 1000).toISOString() : "?";
      console.log(`  • PDA:       ${l.publicKey.toBase58()}`);
      console.log(`    status:    ${status}`);
      console.log(`    collateral: ${collateralUi}  (mint=${a.collateralMint?.toBase58() || "?"})`);
      console.log(`    debt:      ${debt} lamports`);
      console.log(`    due:       ${due}\n`);
    }
  }

  console.log("─────────────────────────────────────────────────");
  if (loans.length === 0) {
    console.log("Summary: wallet has NO loans. Only on-chain holdings are the balances shown above.");
  } else {
    console.log("Summary: wallet has ACTIVE LOAN STATE in the protocol — see loan accounts above.");
    console.log("Reimbursement should account for any collateral + debt in addition to wallet balance.");
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
