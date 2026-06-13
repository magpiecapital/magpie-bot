-- migration 050: add engine_program_id discriminator to limit_close_orders.
--
-- Motivation
-- ──────────
-- Limit-close orders are armed in arm-core and fired by a separate engine
-- process (~/magpie-limitclose). Today every armed order assumes V1
-- program semantics — V1's repay_loan ix signature, V1 PDAs, V1 collateral
-- vault layout. That assumption breaks the moment we widen support to
-- RWA collateral, which lives on V2 (PROGRAM_ID_V2).
--
-- This column records which program ID the engine MUST target when it
-- fires. arm-core computes it from the loan's recorded program_id (which
-- is itself the on-chain owner of the loan PDA — see services/loans.js
-- recordLoan hardening from 2026-06-13).
--
-- Nullable for two reasons:
--   1. Existing rows (memecoin V1 only) stay NULL — the engine treats
--      NULL as "use PROGRAM_ID" (V1). Back-compat by design.
--   2. New rows will get populated by arm-core, but if arm-core ever
--      hits a path where program_id lookup fails (race condition during
--      a re-org or RPC blip), we'd rather record the order without the
--      discriminator and let the engine refuse-to-fire than fail the arm.
--
-- The engine in PR B reads this column. PR C flips the user-facing
-- RWA gate once the engine is verified.

ALTER TABLE limit_close_orders
  ADD COLUMN IF NOT EXISTS engine_program_id text;

CREATE INDEX IF NOT EXISTS limit_close_orders_engine_program_id_idx
  ON limit_close_orders(engine_program_id)
  WHERE engine_program_id IS NOT NULL;

COMMENT ON COLUMN limit_close_orders.engine_program_id IS
  'Solana program ID the fill engine targets when this order fires.
   NULL = default to PROGRAM_ID (V1 memecoin lending — back-compat for
   pre-2026-06-13 orders). Set explicitly by arm-core from the loan''s
   on-chain-verified program_id so engine routing is unambiguous.';
