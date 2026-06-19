/**
 * Find loans the reconciler may have phantom-liquidated.
 *
 * Background: before PR #407, the loan-reconciler called
 * getReadOnlyProgram() with no args (defaults to V1's program). For
 * loans on V3 or V4, fetchMultiple returned null → reconciler marked
 * them 'liquidated'. This script scans every liquidated loan, looks at
 * its on-chain state under its CORRECT program, and lists any that
 * are still Active on-chain (i.e., phantom-marked).
 *
 * Operator can then choose to revert those rows (manual UPDATE), or
 * leave as-is if the on-chain status genuinely matches.
 *
 *   node scripts/find-phantom-liquidations.mjs
 *
 * Read-only. Does not modify any state. Prints a report.
 */
import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import { query } from "../src/db/pool.js";
import {
  getReadOnlyProgram,
  PROGRAM_ID,
  PROGRAM_ID_V3,
  PROGRAM_ID_V4,
} from "../src/solana/program.js";

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toFixed(4);
}

function resolveProgramPubkey(programIdStr) {
  if (!programIdStr) return PROGRAM_ID;
  try {
    const pk = new PublicKey(programIdStr);
    if (pk.equals(PROGRAM_ID)) return PROGRAM_ID;
    if (PROGRAM_ID_V3 && pk.equals(PROGRAM_ID_V3)) return PROGRAM_ID_V3;
    if (PROGRAM_ID_V4 && pk.equals(PROGRAM_ID_V4)) return PROGRAM_ID_V4;
    return pk;
  } catch {
    return null;
  }
}

async function main() {
  console.log("Scanning all loans marked liquidated in the DB...");
  const { rows: liquidated } = await query(
    `SELECT id, loan_id, loan_pda, user_id, program_id,
            original_loan_amount_lamports, updated_at, status
       FROM loans
      WHERE status = 'liquidated'
      ORDER BY updated_at DESC`,
  );
  console.log(`Found ${liquidated.length} liquidated DB rows.\n`);

  if (liquidated.length === 0) {
    console.log("Nothing to investigate.");
    process.exit(0);
  }

  // Group by program_id
  const byProgram = new Map();
  for (const l of liquidated) {
    const pk = resolveProgramPubkey(l.program_id);
    if (!pk) continue;
    const key = pk.toBase58();
    if (!byProgram.has(key)) byProgram.set(key, { programPk: pk, loans: [] });
    byProgram.get(key).loans.push(l);
  }

  const phantomCandidates = [];
  for (const [programKey, { programPk, loans }] of byProgram.entries()) {
    console.log(`--- Program ${programKey.slice(0, 10)}… (${loans.length} loans) ---`);
    const program = getReadOnlyProgram(programPk);
    // Fetch in chunks of 100 to stay under getMultipleAccounts limits.
    for (let i = 0; i < loans.length; i += 100) {
      const chunk = loans.slice(i, i + 100);
      let onChainStates;
      try {
        onChainStates = await program.account.loan.fetchMultiple(
          chunk.map((l) => new PublicKey(l.loan_pda)),
        );
      } catch (err) {
        console.warn(`  chunk fetch failed: ${err.message}`);
        continue;
      }
      for (let j = 0; j < chunk.length; j++) {
        const dbLoan = chunk[j];
        const onChain = onChainStates[j];
        if (!onChain) continue; // genuinely missing on-chain — legit liquidation
        const onChainStatus =
          "repaid" in onChain.status ? "repaid"
          : "liquidated" in onChain.status ? "liquidated"
          : "active";
        if (onChainStatus === "active") {
          phantomCandidates.push({
            db_id: dbLoan.id,
            loan_id: dbLoan.loan_id,
            user_id: dbLoan.user_id,
            program: programKey.slice(0, 10),
            loan_pda: dbLoan.loan_pda,
            original_loan_amount_sol: fmtSol(dbLoan.original_loan_amount_lamports),
            db_marked_liquidated_at: dbLoan.updated_at,
            on_chain_status: onChainStatus,
          });
        }
      }
    }
  }

  console.log(`\n=== PHANTOM LIQUIDATION CANDIDATES ===`);
  console.log(`Total: ${phantomCandidates.length}\n`);
  if (phantomCandidates.length === 0) {
    console.log("No phantoms detected. Every DB-liquidated loan matches its on-chain state.");
    process.exit(0);
  }

  for (const c of phantomCandidates) {
    console.log(
      `  loan.db_id=${c.db_id} loan_id=#${c.loan_id} user_id=${c.user_id} ${c.program} amount=${c.original_loan_amount_sol} SOL marked_at=${c.db_marked_liquidated_at}`,
    );
    console.log(`    pda=${c.loan_pda} on_chain=${c.on_chain_status}`);
  }

  console.log(`\nTo revert these (after manual review), run:`);
  console.log(`  UPDATE loans SET status = 'active', updated_at = NOW() WHERE id IN (${phantomCandidates.map((c) => c.db_id).join(",")});`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
