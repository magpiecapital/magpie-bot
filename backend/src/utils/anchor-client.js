/**
 * Anchor client for the liquidation backend.
 *
 * Loads the lender keypair (from base58 secret or keypair JSON), builds a
 * connection + Anchor Program instance, and exposes helpers for reading the
 * set of active loans.
 */
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "../config/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load the IDL from the bot's copy (single source of truth).
 */
function loadIdl() {
  const idlPath = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "src",
    "solana",
    "idl",
    "bagbank.json",
  );
  return JSON.parse(readFileSync(idlPath, "utf8"));
}

function loadLenderKeypair() {
  if (config.lenderPrivateKey) {
    return Keypair.fromSecretKey(bs58.decode(config.lenderPrivateKey));
  }
  const bytes = new Uint8Array(JSON.parse(readFileSync(config.lenderKeypairPath, "utf8")));
  return Keypair.fromSecretKey(bytes);
}

export function createAnchorProgram() {
  const connection = new Connection(config.rpcEndpoint, "confirmed");
  const lenderKeypair = loadLenderKeypair();

  if (!lenderKeypair.publicKey.equals(config.lenderWallet)) {
    throw new Error(
      `Loaded keypair (${lenderKeypair.publicKey.toBase58()}) does not match LENDER_PUBKEY (${config.lenderWallet.toBase58()})`,
    );
  }

  const wallet = new Wallet(lenderKeypair);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const idl = loadIdl();
  const program = new Program(idl, provider);

  console.log("✅ Anchor program initialized");
  console.log(`   Program: ${program.programId.toBase58()}`);
  console.log(`   Lender:  ${lenderKeypair.publicKey.toBase58()}`);

  return { program, connection, lenderKeypair, provider };
}

/**
 * Fetch every loan account with status == Active.
 */
export async function getAllActiveLoans(program) {
  const all = await program.account.loan.all();
  return all.filter((l) => l.account.status?.active !== undefined);
}

export function lendingPoolPda(programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lending-pool"), config.lenderWallet.toBuffer()],
    programId,
  )[0];
}

export function collateralVaultPda(programId, loanPubkey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("collateral-vault"), loanPubkey.toBuffer()],
    programId,
  )[0];
}
