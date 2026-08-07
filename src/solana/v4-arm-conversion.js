/**
 * V4.1 borrower-armed conversion triggers — `arm_conversion` / `disarm_conversion`.
 *
 * These instructions are the on-chain borrower CONSENT that gates
 * `convert_collateral_slice` (Sec3 H-02). Without an armed trigger, or an
 * overdue loan, the engine cannot move a single token of collateral.
 *
 * TWO CAPS, and getting the difference right is the whole job of this file
 * (Sec3 Q-04):
 *
 *   max_slice_bps — the most a SINGLE fire may take
 *   total_bps     — the most ALL fires may take under this arming
 *
 * A laddered exit fires several legs under one arming. If both numbers were set
 * to the same value the ladder would die at its largest leg: a 70/20/10
 * take-profit ladder needs a 70% per-fire cap but 100% of total authorization,
 * so leg 2 would be refused on-chain. Hence `deriveArmingCaps` below —
 * per-fire is the LARGEST leg, total is the SUM.
 *
 * ⚠️ V4.1 ONLY. These instructions DO NOT EXIST in the deployed V4 program
 * (HA1hgvskN1go…), and V4.1 also changes the Loan account layout. Every entry
 * point here refuses to build unless PROGRAM_ID_V4_1 is explicitly configured,
 * so this can never be aimed at the live program by accident.
 */
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { deriveArmingCaps } from "./arming-caps.js";

// The cap arithmetic lives in ./arming-caps.js — no web3 imports there, so
// the CI guard can verify it without an install step.
export { deriveArmingCaps };

/** take-profit: fire when spot RISES to >= trigger. */
export const DIRECTION_TAKE_PROFIT = 0;
/** stop-loss: fire when spot FALLS to <= trigger. */
export const DIRECTION_STOP_LOSS = 1;

function v41ProgramId() {
  const raw = process.env.PROGRAM_ID_V4_1;
  if (!raw) {
    throw new Error(
      "arm_conversion is V4.1-only and PROGRAM_ID_V4_1 is not set. " +
        "Refusing to build — the deployed V4 program has no such instruction.",
    );
  }
  return new PublicKey(raw);
}

/**
 * Build an `arm_conversion` instruction.
 *
 * @param {import("@coral-xyz/anchor").Program} program V4.1 Anchor program
 * @param {object} p
 * @param {PublicKey} p.loan
 * @param {PublicKey} p.borrower must sign
 * @param {number|bigint} p.triggerPrice lamports per WHOLE collateral token
 * @param {number} p.direction DIRECTION_TAKE_PROFIT | DIRECTION_STOP_LOSS
 * @param {Array<{slicePct:number}>} p.legs the exit spec (1 leg = simple TP/SL)
 */
export async function buildArmConversionIx(program, { loan, borrower, triggerPrice, direction, legs }) {
  const expected = v41ProgramId();
  if (!program.programId.equals(expected)) {
    throw new Error("arm_conversion: program is not the configured V4.1 program");
  }
  if (direction !== DIRECTION_TAKE_PROFIT && direction !== DIRECTION_STOP_LOSS) {
    throw new Error("arm_conversion: direction must be 0 (take-profit) or 1 (stop-loss)");
  }
  const price = BigInt(triggerPrice);
  if (price <= 0n) throw new Error("arm_conversion: trigger price must be > 0");

  const { maxSliceBps, totalBps } = deriveArmingCaps(legs);

  return program.methods
    .armConversion(new BN(price.toString()), direction, maxSliceBps, totalBps)
    .accounts({ loan, borrower })
    .instruction();
}

/** Build a `disarm_conversion` instruction. Borrower must sign. */
export async function buildDisarmConversionIx(program, { loan, borrower }) {
  const expected = v41ProgramId();
  if (!program.programId.equals(expected)) {
    throw new Error("disarm_conversion: program is not the configured V4.1 program");
  }
  return program.methods.disarmConversion().accounts({ loan, borrower }).instruction();
}
