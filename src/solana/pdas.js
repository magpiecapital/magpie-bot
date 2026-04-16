import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { PROGRAM_ID } from "./program.js";

export function lendingPoolPda(lenderPubkey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lending-pool"), lenderPubkey.toBuffer()],
    PROGRAM_ID,
  );
}

export function loanTokenVaultPda(lendingPoolPubkey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("loan-token-vault"), lendingPoolPubkey.toBuffer()],
    PROGRAM_ID,
  );
}

export function loanPda(borrowerPubkey, loanId) {
  const idBuf = Buffer.alloc(8);
  new BN(loanId).toArrayLike(Buffer, "le", 8).copy(idBuf);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("loan"), borrowerPubkey.toBuffer(), idBuf],
    PROGRAM_ID,
  );
}

export function collateralVaultPda(loanPubkey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("collateral-vault"), loanPubkey.toBuffer()],
    PROGRAM_ID,
  );
}
