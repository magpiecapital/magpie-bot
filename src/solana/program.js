import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import "dotenv/config";
import { connection } from "./connection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const idlPath = path.join(__dirname, "idl", "magpie_lending.json");
const idl = JSON.parse(readFileSync(idlPath, "utf8"));

export const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || idl.address,
);

/**
 * Build a read-only Anchor Program for queries that don't need a signer.
 */
export function getReadOnlyProgram() {
  const dummyKp = Keypair.generate();
  const provider = new AnchorProvider(connection, new Wallet(dummyKp), {
    commitment: "confirmed",
  });
  return new Program(idl, provider);
}

/**
 * Build an Anchor Program with a specific signer (e.g. a user's custodial keypair).
 */
export function getProgramForSigner(signerKeypair) {
  const provider = new AnchorProvider(connection, new Wallet(signerKeypair), {
    commitment: "confirmed",
  });
  return new Program(idl, provider);
}
