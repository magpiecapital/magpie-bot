/**
 * GET /api/v1/agent/credit-attest?wallet=<pubkey>
 *
 * Returns a CRYPTOGRAPHICALLY-SIGNED attestation of a wallet's Magpie
 * credit score. Other Solana protocols can verify the signature using
 * the lender authority's public key — no need to trust our API.
 *
 * This is the wedge: agents that borrow + repay on Magpie build an
 * on-chain credit score. The attestation lets ANY other protocol read
 * + trust that score. Portable reputation = network effects.
 *
 * Response shape (JSON):
 *   {
 *     wallet:        "<pubkey>",
 *     score:         750,
 *     tier:          "gold",
 *     loans_total:   12,
 *     loans_repaid:  11,
 *     loans_liquidated: 0,
 *     issued_at:     "2026-06-08T15:30:00.000Z",
 *     expires_at:    "2026-06-15T15:30:00.000Z",
 *     attester:      "<lender-authority pubkey>",
 *     signature:     "<base58 ed25519 signature over signed_payload>",
 *     signed_payload: "<the canonical string that was signed>"
 *   }
 *
 * Verification (any consumer):
 *   1. Reconstruct the canonical payload from the response fields
 *      (sorted JSON minus the signature/signed_payload).
 *   2. Verify with @noble/curves Ed25519 or solana/web3.js using
 *      `attester` as the public key and `signature` as the signature.
 *   3. If signature valid AND issued_at recent → trust the score.
 *
 * Same signature scheme Solana itself uses (ed25519 over the raw
 * payload bytes). The lender authority's pubkey is publicly known
 * (4JSSSaG3... — verifiable on-chain as the protocol authority).
 *
 * Cached at the CDN layer for 60s — credit doesn't change second-to-
 * second and signing per-request is more expensive than the cache hit.
 *
 * This endpoint is FREE to call from the agent's perspective — the
 * paywall lives in magpie-x402 (the proxy in front of it). x402's
 * paid `/agent/:wallet/credit` route forwards here after payment.
 */
import { PublicKey, Keypair } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { query } from "../db/pool.js";
import { getScoreByWallet, tierFromScore } from "../services/credit-score.js";

const ATTESTATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function loadLenderKeypair() {
  const b58 = process.env.LENDER_PRIVATE_KEY;
  if (b58) {
    return Keypair.fromSecretKey(bs58.decode(b58));
  }
  const kpPath = process.env.LENDER_KEYPAIR_PATH || path.resolve("lender-keypair.json");
  const raw = JSON.parse(fs.readFileSync(kpPath, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

/**
 * Canonical signing payload — must be a deterministic stringification
 * of the score fields. Verifiers reconstruct this exact string and
 * pass it to ed25519_verify(payload, signature, attester_pubkey).
 *
 * Format chosen for human-readability + machine-parseability without
 * pulling in a JSON canonicalization library:
 *
 *   "magpie-credit/v1\nwallet=<pubkey>\nscore=<N>\ntier=<name>\n" +
 *   "loans_total=<N>\nloans_repaid=<N>\nloans_liquidated=<N>\n" +
 *   "issued_at=<ISO>\nexpires_at=<ISO>\n"
 */
function canonicalPayload(attestation) {
  return (
    `magpie-credit/v1\n` +
    `wallet=${attestation.wallet}\n` +
    `score=${attestation.score}\n` +
    `tier=${attestation.tier}\n` +
    `loans_total=${attestation.loans_total}\n` +
    `loans_repaid=${attestation.loans_repaid}\n` +
    `loans_liquidated=${attestation.loans_liquidated}\n` +
    `issued_at=${attestation.issued_at}\n` +
    `expires_at=${attestation.expires_at}\n`
  );
}

export async function handleCreditAttest(req, url) {
  if (req.method !== "GET") {
    return { status: 405, body: { error: "GET only" } };
  }
  const wallet = url.searchParams.get("wallet");
  if (!wallet) {
    return { status: 400, body: { error: "wallet query param required" } };
  }
  try {
    new PublicKey(wallet);
  } catch {
    return { status: 400, body: { error: "invalid wallet pubkey" } };
  }

  // Score lookup
  const scoreData = await getScoreByWallet(wallet);
  if (!scoreData) {
    // Wallet has no Magpie history — return a "new" score (unsigned
    // is fine; consumers can infer "untested" from the lack of
    // attestation).
    return {
      status: 200,
      body: {
        wallet,
        score: 300,
        tier: "new",
        loans_total: 0,
        loans_repaid: 0,
        loans_liquidated: 0,
        message: "No Magpie history — this wallet has never borrowed. Attestation withheld until first repayment.",
      },
      headers: { "Cache-Control": "public, max-age=300" },
    };
  }

  // Pull loan counts for this wallet's user
  const { rows: [counts] } = await query(
    `SELECT
       COUNT(*)::int                                    AS total,
       COUNT(*) FILTER (WHERE status = 'repaid')::int   AS repaid,
       COUNT(*) FILTER (WHERE status = 'liquidated')::int AS liquidated
       FROM loans l
       JOIN wallets w ON w.user_id = l.user_id
      WHERE w.public_key = $1`,
    [wallet],
  );

  const now = new Date();
  const expires = new Date(now.getTime() + ATTESTATION_TTL_MS);
  const attestation = {
    wallet,
    score: scoreData.score,
    tier: tierFromScore(scoreData.score),
    loans_total: counts.total,
    loans_repaid: counts.repaid,
    loans_liquidated: counts.liquidated,
    issued_at: now.toISOString(),
    expires_at: expires.toISOString(),
  };

  // Sign the canonical payload with the lender authority key
  let signature, attester;
  try {
    const lender = loadLenderKeypair();
    const payload = canonicalPayload(attestation);
    const sig = nacl.sign.detached(Buffer.from(payload, "utf8"), lender.secretKey);
    signature = bs58.encode(sig);
    attester = lender.publicKey.toBase58();
  } catch (err) {
    console.error("[credit-attest] signing failed:", err.message);
    return {
      status: 500,
      body: { error: "attestation_signing_failed", detail: "Operator lender key not loadable" },
    };
  }

  return {
    status: 200,
    body: {
      ...attestation,
      attester,
      signature,
      signed_payload: canonicalPayload(attestation),
      verification_note: "ed25519. Verify with: nacl.sign.detached.verify(Buffer.from(signed_payload), bs58.decode(signature), bs58.decode(attester))",
    },
    headers: { "Cache-Control": "public, max-age=60" },
  };
}
