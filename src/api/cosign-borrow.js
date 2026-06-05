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
