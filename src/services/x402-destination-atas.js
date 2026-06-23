/**
 * x402 standard-rail destination ATAs (zero-touch, idempotent).
 *
 * The standard x402 v2 SVM "exact" rail settles USDC / wSOL to the protocol's
 * payTo wallet. For an SPL transfer to land, that wallet's Associated Token
 * Accounts must already exist on-chain. The x402 service is KEYLESS by design
 * (custody boundary — it never holds a secret key), so the bot creates them
 * here: the payTo wallet IS the lender wallet (LENDER_PUBKEY == payTo ==
 * 4JSSS…), so the bot's lender keypair both owns the ATAs and pays their rent.
 *
 * Safe under "never affect existing user loans/collateral": this touches ONLY
 * the protocol's OWN receiving ATAs — never a borrower loan, collateral vault,
 * or price feed. Fully idempotent (existence-checked first + idempotent create
 * instruction), so it is safe to run on every boot; it no-ops once the ATAs
 * exist. Each ATA costs ~0.002 SOL rent, paid once.
 */
import {
  PublicKey,
  Transaction,
  Keypair,
  sendAndConfirmRawTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";
import fs from "node:fs";
import { connection, withFailover } from "../solana/connection.js";

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
// payTo for the x402 standard rail == the lender/treasury wallet.
const PAY_TO = new PublicKey(
  process.env.X402_PAY_TO ||
    process.env.LENDER_PUBKEY ||
    "4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx",
);

function loadLenderKeypair() {
  const b58 = process.env.LENDER_PRIVATE_KEY;
  if (b58) {
    const decode = bs58.decode || (bs58.default && bs58.default.decode);
    return Keypair.fromSecretKey(decode(b58));
  }
  const kpPath = process.env.LENDER_KEYPAIR_PATH;
  if (!kpPath) {
    throw new Error(
      "[x402-atas] LENDER_PRIVATE_KEY or LENDER_KEYPAIR_PATH must be set",
    );
  }
  return Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(kpPath, "utf8"))),
  );
}

/**
 * Ensure the USDC + wSOL destination ATAs for the x402 payTo wallet exist.
 * Returns the list of ATAs it actually created (empty if all already present).
 */
export async function ensureX402DestinationAtas(bot = null) {
  // Derivation MUST match the x402 service's destinationAtas()
  // (getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve=true)).
  const targets = [
    { name: "USDC", mint: USDC_MINT },
    { name: "wSOL", mint: NATIVE_MINT },
  ];
  let lender = null;
  const created = [];
  for (const { name, mint } of targets) {
    try {
      const ata = getAssociatedTokenAddressSync(mint, PAY_TO, true, TOKEN_PROGRAM_ID);
      const info = await withFailover((c) => c.getAccountInfo(ata));
      if (info) {
        console.log(`[x402-atas] ${name} destination ATA already exists: ${ata.toBase58()}`);
        continue;
      }
      if (!lender) lender = loadLenderKeypair();
      const ix = createAssociatedTokenAccountIdempotentInstruction(
        lender.publicKey, // payer
        ata,
        PAY_TO, // owner
        mint,
        TOKEN_PROGRAM_ID,
      );
      const tx = new Transaction().add(ix);
      tx.feePayer = lender.publicKey;
      const { blockhash } = await withFailover((c) => c.getLatestBlockhash("confirmed"));
      tx.recentBlockhash = blockhash;
      tx.sign(lender);
      const sig = await sendAndConfirmRawTransaction(connection, tx.serialize(), {
        commitment: "confirmed",
        skipPreflight: false,
      });
      console.log(`[x402-atas] created ${name} destination ATA ${ata.toBase58()} sig=${sig}`);
      created.push({ name, ata: ata.toBase58(), sig });
    } catch (e) {
      console.warn(`[x402-atas] ensure ${name} ATA failed: ${e.message?.slice(0, 160)}`);
    }
  }
  if (created.length && bot) {
    try {
      const { notifyAdmin } = await import("./admin-notify.js");
      await notifyAdmin(
        `[x402-atas] created standard-rail destination ATA(s): ` +
          created.map((c) => `${c.name}=${c.ata.slice(0, 8)}…`).join(", ") +
          `. The x402 standard v2 rail can now settle these assets to payTo — flip X402_STANDARD_RAIL_ENABLED=true to go live.`,
      );
    } catch {}
  }
  return created;
}
