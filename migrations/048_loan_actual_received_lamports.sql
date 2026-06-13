-- migration 048: capture the borrower's ACTUAL on-chain delta per borrow.
--
-- Background
-- Today the `loans` row has:
--   original_loan_amount_lamports  — total principal owed (what user repays)
--   loan_amount_lamports           — principal minus protocol origination fee
--                                    (what the DB *thinks* the user received)
--
-- 2026-06-13 audit found the SECOND value is overstated. The on-chain
-- borrow flow lets account-creation rent come out of the loan
-- proceeds (collateral vault ATA + borrower wSOL ATA, ~0.004414 SOL).
-- That rent never appears as a DB deduction so the dashboard shows
-- a number ~$1 higher than the borrower's wallet actually moved.
--
-- This migration adds a third value: actual_received_lamports — the
-- borrower wallet's NET SOL delta on the borrow tx, fetched on-chain
-- after the tx confirms. This is the canonical "what did you really
-- get" number. The dashboard renders this; the existing fields stay
-- intact for back-compat and repay math.
--
-- NULLable for two reasons:
--   1. Backfill is async — a script populates historical rows after
--      migration runs.
--   2. RPC outage at write time leaves it NULL. The watchdog catches
--      these later and writes the missing value.

ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS actual_received_lamports NUMERIC(20, 0);

CREATE INDEX IF NOT EXISTS loans_actual_received_null_idx
  ON loans(id)
  WHERE actual_received_lamports IS NULL;

COMMENT ON COLUMN loans.actual_received_lamports IS
  'Borrower wallet ACTUAL net SOL delta on the borrow tx (in lamports).
   Distinct from loan_amount_lamports because it subtracts not only
   the protocol origination fee but ALSO Solana account-creation rent
   (collateral vault ATA + borrower wSOL ATA) that the protocol
   silently takes from loan proceeds. The canonical "what did the
   borrower really receive" value — render this in user-facing UI.
   Populated by recordLoan() on insert and by the on-chain-delta
   watchdog if the insert-time read failed.';
