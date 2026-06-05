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

// v2 program (RWA-capable; newer anchor-spl with PausableConfig + ScaledUiAmount
// support). Only set in env once v2 is deployed + validated. Until then, every
// borrow routes to v1 — RWA mints remain disabled in DB so no user can hit
// a not-yet-routable path.
export const PROGRAM_ID_V2 = process.env.PROGRAM_ID_V2
  ? new PublicKey(process.env.PROGRAM_ID_V2)
  : null;

// Categories that should route to v2 once it's deployed. Source of truth
// for the category vocabulary lives in supported_mints.category — keep in
// sync with isRwa() in token-screener.js.
const RWA_CATEGORIES = new Set(["stock", "etf", "metal"]);

/**
 * Pick the program ID for a NEW borrow against the given collateral category.
 * RWAs route to v2 (newer Token-2022 extension support). Everything else —
 * and ALL flows if v2 isn't configured — routes to v1. Fail-safe: when in
 * doubt, return v1, which is the deployed-and-tested program.
 */
export function chooseProgramIdForCategory(category) {
  if (PROGRAM_ID_V2 && RWA_CATEGORIES.has(category)) return PROGRAM_ID_V2;
  return PROGRAM_ID;
}

/**
 * Pick the program for an EXISTING loan (repay/extend/topup/liquidate).
 * Authoritative source is the loans.program_id column populated at borrow
 * time. Older rows backfilled to v1 — handled by COALESCE default.
 */
export function chooseProgramIdForLoan(loanRow) {
  if (loanRow?.program_id) return new PublicKey(loanRow.program_id);
  return PROGRAM_ID;
}

/**
 * Build a read-only Anchor Program for queries that don't need a signer.
 * Pass `programId` to target v2; defaults to v1.
 */
export function getReadOnlyProgram(programId = PROGRAM_ID) {
  const dummyKp = Keypair.generate();
  const provider = new AnchorProvider(connection, new Wallet(dummyKp), {
    commitment: "confirmed",
  });
  return new Program({ ...idl, address: programId.toBase58() }, provider);
}

/**
 * Build an Anchor Program with a specific signer (e.g. a user's custodial keypair).
 * Pass `programId` to target v2; defaults to v1.
 */
export function getProgramForSigner(signerKeypair, programId = PROGRAM_ID) {
  const provider = new AnchorProvider(connection, new Wallet(signerKeypair), {
    commitment: "confirmed",
  });
  return new Program({ ...idl, address: programId.toBase58() }, provider);
}
