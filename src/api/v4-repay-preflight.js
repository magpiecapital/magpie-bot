/**
 * V4 repay-preflight endpoint.
 *
 * GET /api/v1/v4/repay-preflight?wallet=<pubkey>&loan_pda=<pubkey>
 *
 * Returns the canonical owed / wallet / vault / deficit breakdown for a
 * specific loan. Used by:
 *   1. Site dashboard — displayed in a widget on every V4 loan card BEFORE
 *      the user clicks Repay. No more surprises.
 *   2. The site's handleRepay handler — pre-flights BEFORE building the tx.
 *   3. The pre-due-date watcher — DMs users with insufficient wallet +
 *      sufficient vault that their loan needs a top-up.
 *   4. Pip — natural-language "what do I need to repay this loan?"
 *
 * Why this exists
 * ───────────────
 * V4's repay_loan instruction requires the FULL `owed_lamports` to be
 * LIQUID in the user's wallet. The per-loan sol_proceeds_vault (where
 * auto-sell SOL accumulates) is NOT pre-netted at repay time — it flows
 * to the wallet ONLY AFTER repay succeeds. So a user whose vault has 0.4
 * SOL and who owes 0.5 SOL still needs 0.5 SOL in their wallet upfront,
 * even though net cash outlay is just 0.1.
 *
 * Before this endpoint, the site could only show "owed_lamports" and
 * "wallet balance" — never the vault context. Users with a half-filled
 * ladder thought their loan was effectively repaid; in reality they had
 * to top up the full owed amount, sign repay, then watch vault SOL come
 * back. Confusing and a real loss vector if they spent the borrowed SOL
 * without realizing.
 *
 * Per [[feedback_v4_hardening_sprint_2026_06_17]] (Item 1).
 * Per [[project_magpie_v4_repay_funding_gap]].
 *
 * Response shape (200 OK)
 * ───────────────────────
 *   {
 *     ok: true,
 *     program_id: "...",
 *     program_label: "V4" | "V1" | "V2" | "V3",
 *     owed_lamports: "500000000",
 *     wallet_balance_lamports: "200000000",
 *     vault_balance_lamports: "400000000",   // V4 only; 0 for V1/V2/V3
 *     tx_fee_reserve_lamports: "5000000",
 *     // Lamports the user needs to TOP UP into their wallet BEFORE signing.
 *     deficit_lamports: "305000000",
 *     // Lamports they'd have AFTER repay (wallet - owed + vault).
 *     net_wallet_post_repay_lamports: "100000000",
 *     can_repay_now: false,
 *     vault_covers_after_repay: true,
 *     explainer: "You need 0.305 SOL more in your wallet. After repay,
 *                 the 0.4 SOL in your vault will flow back to your
 *                 wallet automatically.",
 *     // For dashboard widget — renders the three line items
 *     widget: {
 *       owed_sol: 0.5,
 *       wallet_sol: 0.2,
 *       vault_sol: 0.4,
 *       deficit_sol: 0.305,
 *       net_post_repay_sol: 0.1,
 *     }
 *   }
 *
 * Errors
 * ──────
 *   400  invalid_wallet | invalid_loan_pda | missing_params
 *   404  loan_not_found_on_chain
 *   500  rpc_error
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const idlDir = path.join(__dirname, "..", "solana", "idl");

// Lazy IDL loaders — cached per-program. Matches the existing idiom in
// src/solana/program.js so V4 IDL drift is loud (clear error if missing)
// instead of silently mis-deserializing.
const _idlCache = new Map();
function loadIdlSync(filename) {
  if (_idlCache.has(filename)) return _idlCache.get(filename);
  const idl = JSON.parse(readFileSync(path.join(idlDir, filename), "utf8"));
  _idlCache.set(filename, idl);
  return idl;
}

const RPC_URL =
  process.env.SOLANA_RPC_URL ||
  process.env.RPC_URL ||
  "https://api.mainnet-beta.solana.com";

// 0.005 SOL — same reserve as the dashboard's pre-flight on
// site/dashboard/page.tsx (priority fee + on-chain interest drift).
const TX_FEE_RESERVE_LAMPORTS = 5_000_000n;

function isValidPubkey(s) {
  if (!s || typeof s !== "string") return false;
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

function deriveSolProceedsVaultV4(loanPda, programIdV4) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("sol-proceeds"), loanPda.toBuffer()],
    programIdV4,
  );
}

/**
 * Reusable preflight helper. The HTTP handler wraps this; the
 * pre-due-date watcher and Pip natural-language tools call it directly
 * (no HTTP roundtrip). Returns the same shape the handler emits in body.
 */
export async function computeV4RepayPreflight({ wallet, loanPda, connection }) {
  const walletPk = new PublicKey(wallet);
  const loanPdaPk = new PublicKey(loanPda);
  return await _computePreflight({ walletPk, loanPdaPk, connection });
}

export async function handleV4RepayPreflight(req, url) {
  if (req.method !== "GET") {
    return { status: 405, body: { error: "GET only" } };
  }
  const walletStr = url.searchParams.get("wallet") || "";
  const loanPdaStr = url.searchParams.get("loan_pda") || "";
  if (!walletStr || !loanPdaStr) {
    return {
      status: 400,
      body: { error: "missing_params", detail: "wallet + loan_pda required" },
    };
  }
  if (!isValidPubkey(walletStr)) {
    return { status: 400, body: { error: "invalid_wallet" } };
  }
  if (!isValidPubkey(loanPdaStr)) {
    return { status: 400, body: { error: "invalid_loan_pda" } };
  }

  const walletPk = new PublicKey(walletStr);
  const loanPdaPk = new PublicKey(loanPdaStr);
  const connection = new Connection(RPC_URL, "confirmed");
  const result = await _computePreflight({ walletPk, loanPdaPk, connection });
  if (!result.ok) {
    return { status: result.status || 500, body: { error: result.error, detail: result.detail } };
  }
  return { status: 200, body: result.body };
}

async function _computePreflight({ walletPk, loanPdaPk, connection }) {
  const walletStr = walletPk.toBase58();

  // Read the loan account to:
  //   - confirm it exists
  //   - confirm program ownership (so we know V1/V2/V3/V4)
  //   - decode `repay_amount` field via Anchor with the right IDL
  let loanAccount;
  try {
    loanAccount = await connection.getAccountInfo(loanPdaPk, "confirmed");
  } catch (err) {
    return { ok: false, status: 500, error: "rpc_error", detail: `getAccountInfo: ${err.message?.slice(0, 160) || err}` };
  }
  if (!loanAccount) {
    return { ok: false, status: 404, error: "loan_not_found_on_chain" };
  }
  const ownerProgramId = loanAccount.owner.toBase58();

  // Decode repay_amount via Anchor with the right IDL (V1/V2/V3/V4).
  let repayLamports;
  let borrowerOnChainStr;
  try {
    const { AnchorProvider, Program } = await import("@coral-xyz/anchor");
    const idlForOwner = await pickIdlForProgram(ownerProgramId);
    if (!idlForOwner) {
      return { ok: false, status: 500, error: "unknown_program", detail: `owner ${ownerProgramId.slice(0, 8)}… has no IDL bundled` };
    }
    const provider = new AnchorProvider(
      connection,
      // read-only — dummy signer, never signs anything
      {
        publicKey: walletPk,
        signTransaction: async (tx) => tx,
        signAllTransactions: async (txs) => txs,
      },
      { commitment: "confirmed" },
    );
    const program = new Program(
      { ...idlForOwner, address: ownerProgramId },
      provider,
    );
    const onChain = await program.account.loan.fetch(loanPdaPk);
    repayLamports = BigInt(onChain.repayAmount.toString());
    borrowerOnChainStr = onChain.borrower.toBase58();
  } catch (err) {
    return { ok: false, status: 500, error: "loan_decode_failed", detail: err.message?.slice(0, 160) || String(err) };
  }

  if (borrowerOnChainStr !== walletStr) {
    return { ok: false, status: 403, error: "not_loan_borrower", detail: "Wallet does not own this loan on chain." };
  }

  // Wallet balance — straightforward SOL lookup.
  let walletLamports;
  try {
    walletLamports = BigInt(await connection.getBalance(walletPk, "confirmed"));
  } catch (err) {
    return { ok: false, status: 500, error: "rpc_error", detail: `wallet_balance: ${err.message?.slice(0, 160) || err}` };
  }

  // Vault balance — V4 only. V1/V2/V3 don't have sol_proceeds_vault.
  let vaultLamports = 0n;
  let isV4 = false;
  const programIdV4Str = process.env.PROGRAM_ID_V4;
  if (programIdV4Str && ownerProgramId === programIdV4Str) {
    isV4 = true;
    try {
      const programIdV4 = new PublicKey(programIdV4Str);
      const [vaultPda] = deriveSolProceedsVaultV4(loanPdaPk, programIdV4);
      const vaultInfo = await connection.getAccountInfo(vaultPda, "confirmed");
      vaultLamports = vaultInfo ? BigInt(vaultInfo.lamports) : 0n;
    } catch {
      // Vault not created yet → 0 balance. The repay flow handles
      // init_if_needed; lookup failure here is not fatal for preflight.
    }
  }

  // Compute the breakdown.
  const needed = repayLamports + TX_FEE_RESERVE_LAMPORTS;
  const canRepayNow = walletLamports >= needed;
  const deficit = canRepayNow ? 0n : needed - walletLamports;
  // Net wallet AFTER a successful repay: wallet pays `repayLamports`,
  // then vault pays back `vaultLamports`. (vault is closed via
  // repay_loan's vault drain.)
  const netWalletPostRepay = walletLamports - repayLamports + vaultLamports;
  const vaultCoversAfterRepay = vaultLamports >= repayLamports;

  const lamportsToSol = (n) => Number(n) / 1e9;
  const owedSol = lamportsToSol(repayLamports);
  const walletSol = lamportsToSol(walletLamports);
  const vaultSol = lamportsToSol(vaultLamports);
  const deficitSol = lamportsToSol(deficit);
  const netPostSol = lamportsToSol(netWalletPostRepay);

  let explainer;
  if (canRepayNow) {
    if (isV4 && vaultLamports > 0n) {
      explainer =
        `You can repay now. After repay, your vault's ${vaultSol.toFixed(4)} SOL ` +
        `flows back to your wallet (net cash out: ${(owedSol - vaultSol).toFixed(4)} SOL).`;
    } else {
      explainer = `You can repay now. Net cash out: ${owedSol.toFixed(4)} SOL.`;
    }
  } else {
    if (isV4 && vaultLamports > 0n) {
      explainer =
        `You need ${deficitSol.toFixed(4)} more SOL in your wallet to repay. ` +
        `After repay, your vault's ${vaultSol.toFixed(4)} SOL flows back to your wallet ` +
        `(net cash out: ${Math.max(0, owedSol - vaultSol).toFixed(4)} SOL).`;
    } else {
      explainer = `You need ${deficitSol.toFixed(4)} more SOL in your wallet to repay.`;
    }
  }

  return {
    ok: true,
    body: {
      ok: true,
      program_id: ownerProgramId,
      program_label: labelForProgram(ownerProgramId),
      owed_lamports: repayLamports.toString(),
      wallet_balance_lamports: walletLamports.toString(),
      vault_balance_lamports: vaultLamports.toString(),
      tx_fee_reserve_lamports: TX_FEE_RESERVE_LAMPORTS.toString(),
      deficit_lamports: deficit.toString(),
      net_wallet_post_repay_lamports: netWalletPostRepay.toString(),
      can_repay_now: canRepayNow,
      vault_covers_after_repay: vaultCoversAfterRepay,
      is_v4: isV4,
      explainer,
      widget: {
        owed_sol: owedSol,
        wallet_sol: walletSol,
        vault_sol: vaultSol,
        deficit_sol: deficitSol,
        net_post_repay_sol: netPostSol,
        tx_fee_reserve_sol: lamportsToSol(TX_FEE_RESERVE_LAMPORTS),
      },
      generated_at: new Date().toISOString(),
    },
  };
}

async function pickIdlForProgram(programId) {
  const v1 = process.env.PROGRAM_ID;
  const v2 = process.env.PROGRAM_ID_V2;
  const v3 = process.env.PROGRAM_ID_V3;
  const v4 = process.env.PROGRAM_ID_V4;
  try {
    if (v4 && programId === v4) return loadIdlSync("magpie-v4.json");
    if (v3 && programId === v3) return loadIdlSync("magpie-v3.json");
    if (v2 && programId === v2) return loadIdlSync("magpie_lending_v2.json");
    if (v1 && programId === v1) return loadIdlSync("magpie_lending.json");
  } catch (err) {
    console.warn(`[v4-repay-preflight] IDL load failed for ${programId.slice(0, 8)}…: ${err.message?.slice(0, 120)}`);
  }
  return null;
}

function labelForProgram(programId) {
  if (programId === process.env.PROGRAM_ID_V4) return "V4";
  if (programId === process.env.PROGRAM_ID_V3) return "V3";
  if (programId === process.env.PROGRAM_ID_V2) return "V2";
  if (programId === process.env.PROGRAM_ID) return "V1";
  return "unknown";
}
