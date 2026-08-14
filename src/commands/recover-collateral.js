/**
 * /recover — operator-only: return off-chain SPL sale proceeds to the LPs.
 *
 * Closes the loop Sec3 opened in L-02. When a loan is liquidated, the wSOL
 * side now routes straight back to the pool, but any residual SPL collateral
 * still goes to the authority to be sold off-chain. Until those proceeds come
 * back, the LPs are carrying a write-off for value that was actually recovered.
 *
 * `recover_liquidated_collateral` is the on-chain way to return it: it moves
 * wSOL from the authority into the pool's loan-token vault and credits
 * total_deposits WITHOUT minting shares — so the value lands with the existing
 * LPs rather than diluting them, and it stays reconciled to the loan it came
 * from via the LiquidationRecovered event.
 *
 * Deliberately manual. This moves real value into the pool and the amount comes
 * from an off-chain sale only a human can confirm, so it is a command the
 * operator runs against a specific liquidated loan — never an automated sweep.
 *
 * ⚠️ V4.1 ONLY. The instruction does not exist in the deployed V4 program, so
 * this refuses to run unless PROGRAM_ID_V4_1 is configured.
 */
import { PublicKey, Keypair } from "@solana/web3.js";
import BN from "bn.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { isAdmin } from "../services/admin.js";
import { query } from "../db/pool.js";
import bs58 from "bs58";
import fs from "node:fs";
import { PROGRAM_ID_V4_1, getProgramForSigner } from "../solana/program.js";
import { lendingPoolPda, loanTokenVaultPda } from "../solana/pdas.js";

/**
 * Load the pool authority the same way the rest of the bot does — env first,
 * keypair path second, and never a CWD-relative default (the fallback that
 * would happily sign with whatever key happens to be lying around).
 */
function loadAuthorityKeypair() {
  if (process.env.LENDER_PRIVATE_KEY) {
    return Keypair.fromSecretKey(bs58.decode(process.env.LENDER_PRIVATE_KEY));
  }
  const kpPath = process.env.LENDER_KEYPAIR_PATH;
  if (!kpPath) {
    throw new Error(
      "LENDER_PRIVATE_KEY or LENDER_KEYPAIR_PATH must be set — refusing the CWD-relative fallback.",
    );
  }
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(kpPath, "utf-8"))));
}

const LAMPORTS_PER_SOL = 1_000_000_000n;

function parseSol(raw) {
  const n = Number(String(raw).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return BigInt(Math.round(n * Number(LAMPORTS_PER_SOL)));
}

export async function handleRecoverCollateral(ctx) {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply("This command is operator-only.");
    return;
  }

  const parts = String(ctx.message?.text || "").trim().split(/\s+/).slice(1);
  const [loanIdRaw, amountRaw] = parts;

  if (!loanIdRaw || !amountRaw) {
    await ctx.reply(
      "Return off-chain SPL sale proceeds to the LPs.\n\n" +
        "`/recover <loan_id> <SOL>`\n\n" +
        "Credits the pool WITHOUT minting shares, so the value lands with the existing LPs " +
        "rather than diluting them. Use the ACTUAL net proceeds of the sale.",
      { parse_mode: "Markdown" },
    );
    return;
  }

  if (!PROGRAM_ID_V4_1) {
    await ctx.reply(
      "V4.1 isn't configured (`PROGRAM_ID_V4_1` unset), and `recover_liquidated_collateral` " +
        "doesn't exist in the deployed V4 program. Nothing to do.",
      { parse_mode: "Markdown" },
    );
    return;
  }

  const lamports = parseSol(amountRaw);
  if (!lamports) {
    await ctx.reply("Amount must be a positive number of SOL, e.g. `/recover 412 1.75`", {
      parse_mode: "Markdown",
    });
    return;
  }

  let loan;
  try {
    const { rows } = await query(
      `SELECT loan_id, loan_pda, program_id, status, collateral_mint
         FROM loans WHERE loan_id = $1 LIMIT 1`,
      [loanIdRaw],
    );
    loan = rows[0];
  } catch (e) {
    await ctx.reply(`Couldn't load loan: ${e.message}`);
    return;
  }
  if (!loan) {
    await ctx.reply(`No loan ${loanIdRaw}.`);
    return;
  }

  // Recovery only makes sense for a liquidated loan — crediting against a live
  // one would misreport where the value came from.
  if (String(loan.status).toLowerCase() !== "liquidated") {
    await ctx.reply(
      `Loan ${loan.loan_id} is *${loan.status}*, not liquidated. ` +
        "Recovery is only for residual collateral sold after a liquidation.",
      { parse_mode: "Markdown" },
    );
    return;
  }
  if (loan.program_id !== PROGRAM_ID_V4_1.toBase58()) {
    await ctx.reply(
      `Loan ${loan.loan_id} belongs to program \`${loan.program_id}\`, not V4.1. ` +
        "Only V4.1 loans support on-chain recovery.",
      { parse_mode: "Markdown" },
    );
    return;
  }

  try {
    const authority = loadAuthorityKeypair();
    const program = getProgramForSigner(authority, PROGRAM_ID_V4_1);
    const [pool] = lendingPoolPda(authority.publicKey, PROGRAM_ID_V4_1);
    const [loanTokenVault] = loanTokenVaultPda(pool, PROGRAM_ID_V4_1);
    const authorityWsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      authority.publicKey,
      false,
      TOKEN_PROGRAM_ID,
    );

    const sig = await program.methods
      .recoverLiquidatedCollateral(new BN(lamports.toString()))
      .accounts({
        pool,
        loan: new PublicKey(loan.loan_pda),
        loanTokenVault,
        authority: authority.publicKey,
        authorityLoanTokenAccount: authorityWsolAta,
        loanTokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    await ctx.reply(
      `Returned *${Number(lamports) / Number(LAMPORTS_PER_SOL)} SOL* to the pool for loan ` +
        `\`${loan.loan_id}\`.\n\nCredited to total_deposits with no shares minted — the value ` +
        `sits with the existing LPs.\n\n\`${sig}\``,
      { parse_mode: "Markdown", disable_web_page_preview: true },
    );
  } catch (e) {
    await ctx.reply(`Recovery failed: ${String(e.message || e).slice(0, 300)}`);
  }
}
