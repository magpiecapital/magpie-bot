/**
 * POST /api/v1/withdraw
 *
 * Lets a user move SOL or SPL tokens out of their MAGPIE-CUSTODIAL wallet
 * by signing an off-chain authentication message with a LINKED external
 * wallet (e.g. their Phantom).
 *
 * SECURITY — read carefully:
 *
 * The custodial keypair lives on this server. If we sign a withdraw
 * blindly, an attacker who can reach this endpoint can drain user funds.
 * Mitigations stacked here:
 *
 *   1. Replay protection: each request includes a random `nonce`.
 *      Inserted into `used_nonces` (PK) — duplicate-key rejects retries.
 *   2. Freshness: signed message must carry an IssuedAt within
 *      ±5 minutes of server time (handles a little clock skew).
 *   3. Ownership: signer pubkey must be present in `wallets` table.
 *      That ties the signer to a TG user_id; we use THAT user_id to
 *      load the custodial keypair. The signer never picks the user.
 *   4. Source binding: signed `From` must equal that user's currently-
 *      active custodial wallet. The signer can't pivot to a wallet
 *      they don't own.
 *   5. Destination restriction (v1 safety): the signed `To` MUST equal
 *      the signer's own pubkey. So even a phished Phantom seed can
 *      only send custodial → that same Phantom (already compromised),
 *      not to an attacker's wallet. Operator can loosen later via
 *      MAGPIE_SITE_WITHDRAW_ANY_DEST=1 if explicitly desired.
 *   6. Rate limit: 1 site-withdraw per 30s per signer (in-memory).
 *
 * The Ed25519 signature is verified against the signer pubkey using
 * Node's built-in crypto.verify (no external sig lib needed).
 */
import {
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { connection } from "../solana/connection.js";
import { query } from "../db/pool.js";
import { loadKeypair } from "../services/wallet.js";
import { alertWithdraw } from "../services/security-alerts.js";
import { rejectIfLocked } from "../services/site-lock.js";
import { rejectIfSiteDisabled } from "../services/site-global.js";

const bs58decode = bs58.decode || (bs58.default && bs58.default.decode);

const SOL_GAS_RESERVE_LAMPORTS = 5_000_000n; // mirror src/commands/withdraw.js
const FRESH_WINDOW_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 30_000; // per-signer rate limit
const ALLOW_ANY_DEST = process.env.MAGPIE_SITE_WITHDRAW_ANY_DEST === "1";

// SPKI DER wrapper prefix for raw Ed25519 public keys. Lets Node's
// crypto.verify consume the 32-byte Solana pubkey directly.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// In-memory per-signer last-attempt timestamps. Sufficient for the rate
// limit goal; cleared on restart, which is fine (low security stakes —
// the heavy gates are nonce + signature + ownership).
const lastAttemptBySigner = new Map();

function verifyEd25519(messageBytes, signatureBytes, pubkeyBytes) {
  const der = Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(pubkeyBytes)]);
  const keyObject = createPublicKey({ key: der, format: "der", type: "spki" });
  return cryptoVerify(null, messageBytes, keyObject, signatureBytes);
}

function parseSignedMessage(text) {
  // Required header so we never accept a message intended for some other
  // protocol or older version of this one.
  if (!text.startsWith("Magpie Withdraw v1")) {
    return { ok: false, reason: "header mismatch" };
  }
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const fields = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    fields[k] = v;
  }
  const required = ["From", "To", "Asset", "Amount", "Nonce", "IssuedAt"];
  for (const k of required) {
    if (!fields[k]) return { ok: false, reason: `missing field: ${k}` };
  }
  return { ok: true, fields };
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      // Cap at 16 KB — the signed payload is well under 1 KB.
      if (total > 16 * 1024) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
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

async function getMintTokenProgram(mint) {
  const info = await connection.getAccountInfo(new PublicKey(mint));
  if (!info) throw new Error(`Mint ${mint} not found`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

export async function handleSiteWithdraw(req) {
  if (req.method !== "POST") {
    return { status: 405, body: { error: "POST only" } };
  }

  const globalReject = await rejectIfSiteDisabled();
  if (globalReject) return globalReject;

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return { status: 400, body: { error: `Invalid body: ${e.message}` } };
  }

  const { signedMessageBase64, signatureBase58, signerPubkey } = body || {};
  if (!signedMessageBase64 || !signatureBase58 || !signerPubkey) {
    return {
      status: 400,
      body: { error: "Missing signedMessageBase64, signatureBase58, or signerPubkey" },
    };
  }

  // ── Gate 0: pubkey + signature shape ──
  let signerPk;
  try {
    signerPk = new PublicKey(signerPubkey);
  } catch {
    return { status: 400, body: { error: "Invalid signerPubkey" } };
  }
  let signatureBytes;
  try {
    signatureBytes = bs58decode(signatureBase58);
    if (signatureBytes.length !== 64) throw new Error("bad length");
  } catch {
    return { status: 400, body: { error: "Invalid signatureBase58" } };
  }

  let messageBytes;
  try {
    messageBytes = Buffer.from(signedMessageBase64, "base64");
    if (messageBytes.length === 0 || messageBytes.length > 1024) {
      throw new Error("size out of range");
    }
  } catch {
    return { status: 400, body: { error: "Invalid signedMessageBase64" } };
  }

  // ── Gate 1: parse + validate message shape ──
  const messageText = messageBytes.toString("utf-8");
  const parsed = parseSignedMessage(messageText);
  if (!parsed.ok) {
    return { status: 400, body: { error: `Malformed signed message: ${parsed.reason}` } };
  }
  const { From, To, Asset, Amount, Nonce, IssuedAt } = parsed.fields;

  // ── Gate 2: freshness ──
  const issuedAt = Date.parse(IssuedAt);
  if (!Number.isFinite(issuedAt)) {
    return { status: 400, body: { error: "Invalid IssuedAt" } };
  }
  const skew = Math.abs(Date.now() - issuedAt);
  if (skew > FRESH_WINDOW_MS) {
    return {
      status: 400,
      body: { error: `Signed message is stale (off by ${Math.round(skew / 1000)}s — re-sign and retry)` },
    };
  }

  // ── Gate 3: rate limit ──
  const now = Date.now();
  const last = lastAttemptBySigner.get(signerPubkey) || 0;
  if (now - last < MIN_INTERVAL_MS) {
    const wait = Math.ceil((MIN_INTERVAL_MS - (now - last)) / 1000);
    return { status: 429, body: { error: `Too fast — wait ${wait}s and try again` } };
  }
  lastAttemptBySigner.set(signerPubkey, now);

  // ── Gate 4: signature verification ──
  let sigOk;
  try {
    sigOk = verifyEd25519(messageBytes, signatureBytes, signerPk.toBytes());
  } catch (e) {
    console.warn("[site-withdraw] verify threw:", e.message);
    return { status: 400, body: { error: "Signature verification failed" } };
  }
  if (!sigOk) {
    return { status: 401, body: { error: "Signature does not match signer" } };
  }

  // ── Gate 5: ownership — signer must be a linked wallet ──
  // Prefer the TG-linked user_id when present so withdraw activity
  // is attributed to the human's TG identity (matches /repay et al).
  const { resolveWalletOwner } = await import("../services/wallet-owner-resolver.js");
  const resolvedUserId = await resolveWalletOwner(signerPubkey);
  const walletRow = resolvedUserId ? { user_id: resolvedUserId } : null;
  if (!walletRow) {
    return {
      status: 403,
      body: { error: "Signer wallet is not linked to a Magpie account" },
    };
  }
  const userId = walletRow.user_id;

  // ── Gate 5b: kill-switch check ──
  const lockResp = await rejectIfLocked(userId);
  if (lockResp) return lockResp;

  // ── Gate 6: From must equal user's active custodial wallet ──
  let signer;
  try {
    signer = await loadKeypair(userId);
  } catch (e) {
    return {
      status: 500,
      body: { error: `Could not load custodial wallet: ${e.message?.slice(0, 100)}` },
    };
  }
  if (signer.publicKey.toBase58() !== From) {
    return {
      status: 400,
      body: {
        error:
          "Signed 'From' does not match your active custodial wallet. Switch wallets via TG /wallets and try again.",
      },
    };
  }

  // ── Gate 7: To restriction ──
  // v1 — destination must equal the signing wallet, unless the operator
  // has explicitly opted into the wider behavior.
  if (!ALLOW_ANY_DEST && To !== signerPubkey) {
    return {
      status: 400,
      body: {
        error:
          "For safety, site withdraws can only send to the signing wallet itself. To send elsewhere, use TG /withdraw.",
      },
    };
  }

  // ── Gate 8: nonce one-shot insert ──
  // Doing this BEFORE the on-chain tx means even an aborted submission
  // can't be replayed. Side effect: if the on-chain step fails, the user
  // must re-sign a fresh message — that's intentional, not a bug.
  try {
    await query(
      `INSERT INTO used_nonces(nonce, purpose, signer_pubkey) VALUES($1, $2, $3)`,
      [Nonce, "site_withdraw", signerPubkey],
    );
  } catch (e) {
    if (e.code === "23505") {
      return { status: 409, body: { error: "Nonce already used — re-sign a fresh message" } };
    }
    throw e;
  }

  // ── Resolve asset + amount ──
  let decimals;
  let maxLamports;
  let destPk;
  try {
    destPk = new PublicKey(To);
  } catch {
    return { status: 400, body: { error: "Invalid To address" } };
  }
  let rawAmount;
  try {
    rawAmount = BigInt(Amount);
  } catch {
    return { status: 400, body: { error: "Amount must be an integer string" } };
  }
  if (rawAmount <= 0n) {
    return { status: 400, body: { error: "Amount must be positive" } };
  }

  // Pull live balance and decimals from chain — same source-of-truth
  // pattern as src/commands/withdraw.js. Float displays never enter.
  if (Asset === "SOL") {
    decimals = 9;
    const bal = BigInt(await connection.getBalance(signer.publicKey));
    maxLamports = bal > SOL_GAS_RESERVE_LAMPORTS ? bal - SOL_GAS_RESERVE_LAMPORTS : 0n;
  } else {
    let mintPk;
    try {
      mintPk = new PublicKey(Asset);
    } catch {
      return { status: 400, body: { error: "Asset must be SOL or a valid mint pubkey" } };
    }
    const tokenProgram = await getMintTokenProgram(Asset);
    const mintInfo = await connection.getParsedAccountInfo(mintPk);
    decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    const ata = getAssociatedTokenAddressSync(mintPk, signer.publicKey, false, tokenProgram);
    const ataInfo = await connection.getTokenAccountBalance(ata).catch(() => null);
    maxLamports = ataInfo ? BigInt(ataInfo.value.amount) : 0n;
  }
  if (rawAmount > maxLamports) {
    return {
      status: 400,
      body: {
        error: "Amount exceeds available balance",
        requested: rawAmount.toString(),
        available: maxLamports.toString(),
      },
    };
  }

  // ── Record the attempt up front so we have an audit row even if
  //    the tx silently disappears in flight ──
  const { rows: [auditRow] } = await query(
    `INSERT INTO site_withdrawals
       (user_id, signer_pubkey, from_pubkey, to_pubkey, asset, raw_amount, decimals, status)
     VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, 'submitted')
     RETURNING id`,
    [userId, signerPubkey, From, To, Asset, rawAmount.toString(), decimals],
  );
  const auditId = auditRow.id;

  // ── Build + sign + send ──
  let signature;
  try {
    let tx;
    if (Asset === "SOL") {
      tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        SystemProgram.transfer({
          fromPubkey: signer.publicKey,
          toPubkey: destPk,
          lamports: rawAmount,
        }),
      );
    } else {
      const mintPk = new PublicKey(Asset);
      const tokenProgram = await getMintTokenProgram(Asset);
      const fromAta = getAssociatedTokenAddressSync(mintPk, signer.publicKey, false, tokenProgram);
      const toAta = getAssociatedTokenAddressSync(mintPk, destPk, false, tokenProgram);
      tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        createAssociatedTokenAccountIdempotentInstruction(
          signer.publicKey,
          toAta,
          destPk,
          mintPk,
          tokenProgram,
        ),
        createTransferCheckedInstruction(
          fromAta,
          mintPk,
          toAta,
          signer.publicKey,
          rawAmount,
          decimals,
          [],
          tokenProgram,
        ),
      );
    }
    signature = await sendAndConfirmTransaction(connection, tx, [signer]);
  } catch (e) {
    await query(
      `UPDATE site_withdrawals SET status='failed', error_text=$2 WHERE id=$1`,
      [auditId, (e.message || "unknown").slice(0, 500)],
    );
    console.error(`[site-withdraw] tx failed for user ${userId}:`, e.message);
    return { status: 500, body: { error: "Withdraw transaction failed", detail: e.message?.slice(0, 200) } };
  }

  await query(
    `UPDATE site_withdrawals SET status='confirmed', tx_signature=$2 WHERE id=$1`,
    [auditId, signature],
  );

  // Fire-and-forget TG security DM. Failure is non-critical — the
  // withdraw already succeeded; the alert is defense-in-depth so the
  // user notices a stolen-seed scenario quickly.
  const displayAmount = (Number(rawAmount) / 10 ** decimals).toFixed(
    decimals === 9 ? 4 : Math.min(decimals, 6),
  );
  alertWithdraw({
    userId,
    asset: Asset,
    displayAmount,
    destination: To,
    txSig: signature,
  }).catch(() => {});

  return {
    status: 200,
    body: {
      ok: true,
      signature,
      explorer: `https://solscan.io/tx/${signature}`,
    },
  };
}
