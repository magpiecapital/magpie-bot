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
// V2 IDL — different account layout (no fee_wallet field on LendingPool;
// the V2 program enforces fee routing via the authority-signed borrow tx
// rather than a stored fee_wallet pubkey). Loading it lazily here so
// existing V1 callers don't pay the parse cost.
const idlPathV2 = path.join(__dirname, "idl", "magpie_lending_v2.json");
let _idlV2 = null;
function getV2Idl() {
  if (!_idlV2) _idlV2 = JSON.parse(readFileSync(idlPathV2, "utf8"));
  return _idlV2;
}
// V3 IDL — RWA + memecoin dual-tier program live since 2026-06-13. V3's
// Loan account adds {collateral_value_at_start, vault_bump, category}
// after the V1 fields. Reading a V3 Loan with the V1 IDL silently
// mis-deserializes the appended fields and trips Borsh leftover-bytes
// errors during program.account.loan.fetch(). recordLoan in cosign-borrow
// fetches the Loan account post-submit, so it needs the matching IDL.
const idlPathV3 = path.join(__dirname, "idl", "magpie-v3.json");
let _idlV3 = null;
function getV3Idl() {
  if (!_idlV3) _idlV3 = JSON.parse(readFileSync(idlPathV3, "utf8"));
  return _idlV3;
}

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

// v3 = on-chain TWAP memecoin program. Only routable when BOTH:
//   - PROGRAM_ID_V3 is set (program deployed to mainnet)
//   - ROUTE_MEMECOINS_TO_V3=true (operator flipped the switch)
// Default behavior: memecoin borrows continue to route to v1, identical
// to today. Flipping the env routes NEW borrows to v3; v1 loans already
// open continue to repay/extend/liquidate via v1 because chooseProgramIdForLoan
// reads loans.program_id from the DB.
export const PROGRAM_ID_V3 = process.env.PROGRAM_ID_V3
  ? new PublicKey(process.env.PROGRAM_ID_V3)
  : null;
const ROUTE_MEMECOINS_TO_V3 = process.env.ROUTE_MEMECOINS_TO_V3 === "true";
// 2026-06-14: when V3 launches with the genuine 50/60/70% RWA tier ladder,
// flip this to "true" to route NEW RWA borrows to V3 instead of V2.
// Existing V2 RWA loans continue to serve from V2 because each loan
// row stores its own program_id (loans.program_id), so repay/extend/
// liquidate paths are program-loyal — they don't read this flag.
const ROUTE_RWA_TO_V3 = process.env.ROUTE_RWA_TO_V3 === "true";

// Categories that should route to v2 once it's deployed. Source of truth
// for the category vocabulary lives in supported_mints.category — keep in
// sync with isRwa() in token-screener.js.
const RWA_CATEGORIES = new Set(["stock", "etf", "metal"]);

/**
 * The v2 pool is RWA-ONLY. Anything that isn't a tokenized real-world
 * asset (stock/etf/metal) MUST route to v1. The check is symmetric:
 *   v2 ⇔ category ∈ RWA_CATEGORIES
 *
 * 2026-06-07: hard-coded after the $FATHER incident, where a memecoin
 * misclassified as "stock" routed to v2 and bypassed memecoin-only
 * defenses. If you ever add a non-RWA category that should route to
 * v2, deploy a separate program for it — do NOT broaden this set.
 */
export function isRwaCategory(category) {
  return RWA_CATEGORIES.has(category);
}

/**
 * Pick the program ID for a NEW borrow against the given collateral category.
 *
 *   RWA (stock/etf/metal) → v3 (if configured AND ROUTE_RWA_TO_V3=true)
 *                          otherwise v2 (if configured), otherwise v1
 *   memecoin (default)    → v3 (if configured AND ROUTE_MEMECOINS_TO_V3=true)
 *                          otherwise v1
 *
 * Existing loans repay against THEIR original program (loans.program_id);
 * this routing only governs NEW borrows. Operator flips routing flags
 * one category at a time so the V3 rollout is staged.
 *
 * Fail-safe: when in doubt, return v1, which is the deployed-and-tested
 * program. The env-gating means v3 only activates when the operator
 * explicitly confirms deploy + readiness.
 */
export function chooseProgramIdForCategory(category) {
  if (RWA_CATEGORIES.has(category)) {
    if (PROGRAM_ID_V3 && ROUTE_RWA_TO_V3) return PROGRAM_ID_V3;
    if (PROGRAM_ID_V2) return PROGRAM_ID_V2;
    return PROGRAM_ID;
  }
  // Non-RWA path
  if (PROGRAM_ID_V3 && ROUTE_MEMECOINS_TO_V3) return PROGRAM_ID_V3;
  return PROGRAM_ID;
}

/**
 * Defense-in-depth assertion. Throws if a v2 program ID is paired with a
 * non-RWA category — that should be impossible if the routing logic is
 * correct, but catching it here means a corrupt DB row, a manual
 * /enablemint typo, or future code drift can't silently put a memecoin
 * into the RWA pool. Callers in the borrow flow MUST call this.
 */
export function assertProgramMatchesCategory(programId, category) {
  if (!programId) return;
  const isRwa = RWA_CATEGORIES.has(category);
  const routesToV2 = PROGRAM_ID_V2 && programId.equals(PROGRAM_ID_V2);
  const routesToV3 = PROGRAM_ID_V3 && programId.equals(PROGRAM_ID_V3);
  const routesToV1 = !routesToV2 && !routesToV3; // default

  // Pool semantics as of 2026-06-13 (V3 launch):
  //   V1: memecoin-only (legacy memecoin lending)
  //   V2: RWA-only (legacy RWA lending; existing loans still serviced)
  //   V3: BOTH memecoin AND RWA (dual-tier program — RWA gets the
  //       50/60/70% ladder, memecoin keeps 30/25/20%)
  //
  // Invalid combinations (hard fail):
  //   V2 + memecoin (the $FATHER class of vulnerability — never)
  //   V1 + RWA      (RWAs must go to V2 or V3, not V1)
  //
  // Pre-2026-06-13 there was a third "V3 + RWA" hard-stop here because
  // V3 used to be memecoin-only. The 2026-06-14 RWA route-flip
  // (PR #225 + ROUTE_RWA_TO_V3=true) made V3 the active RWA target,
  // so that assertion is now stale + actively wrong — it was breaking
  // /borrow for tokenized stocks. Removed below.

  if (routesToV2 && !isRwa) {
    throw new Error(
      `Program/category mismatch: V2 pool requires RWA category, got "${category ?? "<null>"}". ` +
        `Memecoins must never route to V2. This is a hard safety stop — review the mint's ` +
        `supported_mints.category column.`,
    );
  }
  if (routesToV1 && isRwa) {
    throw new Error(
      `Program/category mismatch: category "${category}" is RWA but program routes to V1. ` +
        `RWAs belong in V2 (legacy) or V3 — check chooseProgramIdForCategory + the routing env flag.`,
    );
  }
  // V3 + RWA: VALID — V3 has the new RWA ladder.
  // V3 + memecoin: VALID — V3 dual-tier supports memecoin too.
  // V1 + memecoin: VALID — default path.
  // V2 + RWA: VALID — legacy RWA pool.
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
  // Pick the matching IDL: V1 (legacy), V2 (authority-routed fees),
  // V3 (RWA + memecoin dual ladder, appended Loan fields). Using the
  // wrong IDL silently mis-deserializes every field past the layout
  // divergence — caught the missing V2 fee_wallet during 2026-06-12
  // and the V3 Loan size mismatch during 2026-06-14.
  let useIdl = idl;
  if (PROGRAM_ID_V3 && programId.equals(PROGRAM_ID_V3)) {
    useIdl = getV3Idl();
  } else if (PROGRAM_ID_V2 && programId.equals(PROGRAM_ID_V2)) {
    useIdl = getV2Idl();
  }
  return new Program({ ...useIdl, address: programId.toBase58() }, provider);
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
