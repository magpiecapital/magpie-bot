import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { PROGRAM_ID, PROGRAM_ID_V3 } from "./program.js";

// All PDA derivations accept an optional `programId` so v1 and v2 callers
// can share these functions. Defaulting to v1's PROGRAM_ID keeps every
// existing call site behaviorally identical.

export function lendingPoolPda(lenderPubkey, programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), lenderPubkey.toBuffer()],
    programId,
  );
}

export function loanTokenVaultPda(lendingPoolPubkey, programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("loan-token-vault"), lendingPoolPubkey.toBuffer()],
    programId,
  );
}

export function loanPda(borrowerPubkey, loanId, programId = PROGRAM_ID) {
  const idBuf = Buffer.alloc(8);
  new BN(loanId).toArrayLike(Buffer, "le", 8).copy(idBuf);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("loan"), borrowerPubkey.toBuffer(), idBuf],
    programId,
  );
}

export function collateralVaultPda(loanPubkey, programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("collateral-vault"), loanPubkey.toBuffer()],
    programId,
  );
}

export function priceFeedPda(mintPubkey, poolPubkey, programId = PROGRAM_ID) {
  // V3 uses a different seed prefix ("price_v3") to keep its price
  // feed PDAs distinct from v1/v2. The mainnet program (B8AwYzFm…)
  // enforces this via Anchor seeds constraint — passing the v1/v2
  // "price" seed against v3 triggers ConstraintSeeds (2006) and the
  // borrow simulation in Phantom shows StalePriceAttestation.
  // Detected 2026-06-14 when V3 RWA borrows started failing for every
  // Xs-prefixed xStocks mint immediately after V3 routing went live.
  const isV3 = PROGRAM_ID_V3 && programId.equals(PROGRAM_ID_V3);
  const seedPrefix = isV3 ? "price_v3" : "price";
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seedPrefix), mintPubkey.toBuffer(), poolPubkey.toBuffer()],
    programId,
  );
}
