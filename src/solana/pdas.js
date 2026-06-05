import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { PROGRAM_ID } from "./program.js";

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
  return PublicKey.findProgramAddressSync(
    [Buffer.from("price"), mintPubkey.toBuffer(), poolPubkey.toBuffer()],
    programId,
  );
}
