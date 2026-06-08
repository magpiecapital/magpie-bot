/**
 * POST /api/v1/cosign-borrow
 *
 * The site builds a borrow tx client-side (with the user signing as
 * borrower), then sends the partial-signed tx here for the lender
 * authority to add its signature. We submit the fully-signed tx and
 * return the signature.
 *
 * SECURITY — read this before changing anything in this file:
 *
 * The lender keypair is the same authority that controls admin_withdraw,
 * set_paused, set_keeper_reward, update_price, etc. Blindly signing
 * arbitrary txs sent by the site would let an attacker drain the pool.
 * This endpoint is HARD-RESTRICTED to one specific instruction:
 *
 *   request_and_fund_loan (discriminator [21,217,199,183,6,96,200,52])
 *
 * Any tx whose magpie-program instructions don't ALL match that
 * discriminator is rejected outright. Other programs (Compute Budget,
 * System, Token, ATA) are unrestricted — they have no privileged
 * relationship with the lender wallet.
 *
 * Defense in depth:
 *   - Tx must include exactly one instruction to v1 OR v2b program
 *   - That instruction's discriminator MUST match request_and_fund_loan
 *   - Borrower signature must already be on the tx (we sign last)
 *   - Lender authority must be in the tx as a signer (sanity check)
 *
 * Anyone reading this should re-verify each check before approving
 * a PR that touches it.
 */
import {
  PublicKey,
  Transaction,
  VersionedTransaction,
  Keypair,
  sendAndConfirmRawTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import fs from "node:fs";
import path from "node:path";
import { connection } from "../solana/connection.js";
import { isWalletBanned } from "../services/bans.js";

// Programs the lender authority has privileges over
const V1_PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh",
);
const V2_PROGRAM_ID = process.env.PROGRAM_ID_V2
  ? new PublicKey(process.env.PROGRAM_ID_V2)
  : null;

const LENDER_PUBKEY = new PublicKey(process.env.LENDER_PUBKEY);

// Strict allowlist of instruction discriminators we'll co-sign for the
// magpie programs. Anything else → reject.
const ALLOWED_DISCRIMINATORS = [
  // request_and_fund_loan (verified from src/solana/idl/magpie_lending.json)
  Buffer.from([21, 217, 199, 183, 6, 96, 200, 52]),
];

// CRITICAL — drain-exploit prevention (2026-06-07):
//
// An attacker crafted a borrow tx that included a System.transfer at
// the OUTER instruction level, source = LENDER, draining 0.71 SOL per
// tx. The previous gates only validated magpie-program instructions —
// every non-magpie instruction passed through unchecked. The attacker
// abused this by including the magpie.request_and_fund_loan to pass
// gate 1, then attaching SystemProgram.transfer { source: LENDER }
// to drain SOL on the same tx the lender co-signed.
//
// Fix: program allowlist. Every outer instruction's programId must
// be in this set. SystemProgram is INTENTIONALLY excluded — borrow.ts
// never emits a System instruction at the outer level (System CPIs
// happen INSIDE the magpie program / ATA program, not outer).
//
// If you ever change borrow.ts to emit a System instruction at the
// outer level (e.g. a tip / fee transfer), add SystemProgram here AND
// add an instruction-level check that source !== LENDER_PUBKEY.
const OUTER_INSTRUCTION_PROGRAM_ALLOWLIST = new Set([
  V1_PROGRAM_ID.toBase58(),
  ...(V2_PROGRAM_ID ? [V2_PROGRAM_ID.toBase58()] : []),
  "ComputeBudget111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",  // Associated Token Account
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",  // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",  // Token-2022
]);

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

function loadLenderKeypair() {
  const b58 = process.env.LENDER_PRIVATE_KEY;
  if (b58) {
    const decode = bs58.decode || (bs58.default && bs58.default.decode);
    return Keypair.fromSecretKey(decode(b58));
  }
  const kpPath = process.env.LENDER_KEYPAIR_PATH || path.resolve("lender-keypair.json");
  const raw = JSON.parse(fs.readFileSync(kpPath, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

function isMagpieProgram(programIdPk) {
  if (programIdPk.equals(V1_PROGRAM_ID)) return true;
  if (V2_PROGRAM_ID && programIdPk.equals(V2_PROGRAM_ID)) return true;
  return false;
}

function instructionAllowed(ixData) {
  const head = Buffer.from(ixData.slice(0, 8));
  return ALLOWED_DISCRIMINATORS.some((d) => d.equals(head));
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export async function handleCosignBorrow(req) {
  if (req.method !== "POST") {
    return { status: 405, body: { error: "POST only" } };
  }

  // KILL SWITCH — set COSIGN_BORROW_DISABLED=true on Railway to disable
  // all site-borrow co-signing without redeploying. Useful if we ever
  // detect another anomaly: flip the env var, the next request returns
  // 503, the drain stops in seconds.
  if (process.env.COSIGN_BORROW_DISABLED === "true") {
    console.warn("[cosign-borrow] disabled via COSIGN_BORROW_DISABLED env var");
    return {
      status: 503,
      body: {
        error: "Site-borrow co-signing is temporarily disabled",
        detail: "Use the Telegram bot for borrows while this is paused.",
      },
    };
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: "Invalid JSON body" } };
  }
  const partialSignedTxBase64 = body?.partialSignedTxBase64;
  if (typeof partialSignedTxBase64 !== "string" || !partialSignedTxBase64) {
    return { status: 400, body: { error: "Missing partialSignedTxBase64" } };
  }

  // Deserialize. Try legacy Transaction first (matches what the site builds).
  let tx;
  try {
    tx = Transaction.from(Buffer.from(partialSignedTxBase64, "base64"));
  } catch {
    try {
      const v = VersionedTransaction.deserialize(Buffer.from(partialSignedTxBase64, "base64"));
      // Versioned tx support requires v0 message handling — not implemented here.
      // Reject to stay safe and force the site to use legacy txs (which the
      // existing borrow.ts builder produces anyway).
      void v;
      return { status: 400, body: { error: "Versioned txs not supported by this endpoint yet" } };
    } catch {
      return { status: 400, body: { error: "Failed to deserialize transaction" } };
    }
  }

  // ── SECURITY GATES ──────────────────────────────────────────────

  // Gate 0 (NEW, post-2026-06-07 exploit): outer-program allowlist.
  // Every outer instruction's program must be on the allowlist. This is
  // the drain-prevention gate: SystemProgram is intentionally NOT on
  // the list, so an attacker cannot attach a SystemProgram.transfer
  // { source: LENDER } to a tx the lender co-signs.
  //
  // Belt-and-suspenders: even if we add SystemProgram to the allowlist
  // in the future, the immediate-rejection check below catches any
  // System.transfer where source === LENDER, regardless of allowlist.
  for (let i = 0; i < tx.instructions.length; i++) {
    const ix = tx.instructions[i];
    const programIdStr = ix.programId.toBase58();

    if (!OUTER_INSTRUCTION_PROGRAM_ALLOWLIST.has(programIdStr)) {
      console.error(`[cosign-borrow] DRAIN-ATTEMPT BLOCKED: outer ix[${i}] program ${programIdStr} not on allowlist`);
      return {
        status: 403,
        body: {
          error: "instruction program not allowed in co-signed tx",
          detail: `outer instruction ${i} targets program ${programIdStr}; allowed: ${[...OUTER_INSTRUCTION_PROGRAM_ALLOWLIST].join(", ")}`,
        },
      };
    }

    // Defense-in-depth — if System ever gets re-added to the allowlist,
    // still reject any System.transfer where the lender is the source.
    if (programIdStr === SYSTEM_PROGRAM_ID) {
      // System.transfer = u32 discriminator [2,0,0,0] then u64 lamports.
      // Account 0 is the source. We don't deserialize amount here — the
      // mere fact that LENDER is account 0 of a System ix on the outer
      // tx is enough to reject.
      const sourceAccountIdx = ix.keys?.[0]?.pubkey;
      if (sourceAccountIdx && sourceAccountIdx.equals(LENDER_PUBKEY)) {
        console.error(`[cosign-borrow] DRAIN-ATTEMPT BLOCKED: outer System ix[${i}] sources from LENDER`);
        return {
          status: 403,
          body: {
            error: "System instruction with LENDER as source is not allowed",
            detail: `outer instruction ${i} is a System call where account[0] = lender authority — would drain SOL`,
          },
        };
      }
    }
  }

  // Gate 1: at least one magpie-program instruction must be present,
  //          and ALL magpie-program instructions must be allowed.
  let magpieIxCount = 0;
  for (const ix of tx.instructions) {
    if (!isMagpieProgram(ix.programId)) continue;
    magpieIxCount++;
    if (!instructionAllowed(ix.data)) {
      return {
        status: 403,
        body: {
          error: "instruction not allowed",
          detail: `instruction discriminator ${[...ix.data.slice(0, 8)].join(",")} is not on the co-sign allowlist (request_and_fund_loan only)`,
        },
      };
    }
  }
  if (magpieIxCount === 0) {
    return { status: 400, body: { error: "No magpie-program instruction found in transaction" } };
  }
  if (magpieIxCount > 1) {
    // Defense in depth: even if all instructions match the allowlist, more
    // than one borrow per tx is suspicious. Reject.
    return { status: 400, body: { error: "Multiple magpie instructions in one tx — refusing to co-sign" } };
  }

  // Gate 2: lender authority must be a required signer in the tx.
  //          (If they're not, signing does nothing — but we also want to
  //          fail loudly rather than waste compute.)
  const lenderIsSigner = tx.signatures.some(
    (s) => s.publicKey.equals(LENDER_PUBKEY),
  );
  if (!lenderIsSigner) {
    return { status: 400, body: { error: "Lender authority is not a signer in this transaction" } };
  }

  // Gate 3: borrower (the user) must have already signed. If we sign first
  //          and return, an attacker could submit the bot's signature
  //          without ever paying for the rent/setup ixs. Requiring the
  //          borrower sig means the tx is already authorized end-to-end
  //          when we add ours.
  const borrowerAlreadySigned = tx.signatures.some(
    (s) => !s.publicKey.equals(LENDER_PUBKEY) && s.signature !== null,
  );
  if (!borrowerAlreadySigned) {
    return { status: 400, body: { error: "Borrower has not signed yet — co-sign endpoint signs last" } };
  }

  // Gate 4 (NEW, 2026-06-07): borrower wallet must not be on the ban list.
  // Catches the case where a banned wallet attempts to open a loan via
  // the web path. Wallet-level ban applies regardless of which TG account
  // (if any) owns it.
  const borrowerSig = tx.signatures.find(
    (s) => !s.publicKey.equals(LENDER_PUBKEY) && s.signature !== null,
  );
  if (borrowerSig) {
    const borrowerPubkey = borrowerSig.publicKey.toBase58();
    try {
      if (await isWalletBanned(borrowerPubkey)) {
        console.warn(`[cosign-borrow] refused — banned wallet ${borrowerPubkey}`);
        return {
          status: 403,
          body: {
            error: "This wallet is restricted from opening new loans.",
            detail: "Contact support if you believe this is in error.",
          },
        };
      }
    } catch (banErr) {
      // Fail open — don't break legit borrows on transient DB issues.
      console.warn("[cosign-borrow] ban check failed (fail-open):", banErr.message);
    }
  }

  // All gates passed. Add the lender signature.
  let lender;
  try {
    lender = loadLenderKeypair();
  } catch (e) {
    console.error("[cosign-borrow] keypair load failed:", e.message);
    return { status: 500, body: { error: "Lender keypair unavailable" } };
  }

  tx.partialSign(lender);

  // Submit the fully-signed tx ourselves so the site doesn't need
  // submit/confirm logic for what's now a fully-signed payload.
  let signature;
  try {
    const raw = tx.serialize();
    signature = await sendAndConfirmRawTransaction(connection, raw, {
      commitment: "confirmed",
      skipPreflight: false,
      maxRetries: 3,
    });
  } catch (e) {
    return {
      status: 500,
      body: { error: "Submission failed", detail: e.message?.slice(0, 200) },
    };
  }

  return {
    status: 200,
    body: { ok: true, signature },
  };
}
