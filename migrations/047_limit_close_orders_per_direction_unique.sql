-- migration 047: allow ONE armed TP + ONE armed SL on the same loan.
--
-- Background
-- Previously a UNIQUE partial index on (loan_id WHERE status='armed')
-- physically capped a loan to ONE armed limit-close order at a time.
-- That meant a borrower had to choose between take-profit OR
-- stop-loss; they couldn't protect both sides simultaneously.
--
-- This migration replaces that index with a per-direction one. Now:
--   ONE armed TP (trigger_direction='above')   +   ONE armed SL
--   (trigger_direction='below')   on the same loan is allowed.
--   TWO armed TPs OR TWO armed SLs on the same loan still throws —
--   that's the intended dedupe: you can't have two TPs racing.
--
-- COALESCE handles legacy rows that pre-date the trigger_direction
-- column (migration 039); they're treated as TP ('above'), matching
-- the column DEFAULT.
--
-- Engine-side effect (paired magpie-limitclose change): when one
-- order fires successfully, the loan is closed (collateral sold,
-- repay done), so any sibling armed order on that loan must be
-- auto-cancelled with reason='sibling_order_fired'. Without that,
-- an SL on a TP'd-out loan would sit armed against a non-existent
-- position. Engine handles this in markFired().

DROP INDEX IF EXISTS limit_close_orders_one_armed_per_loan_idx;

CREATE UNIQUE INDEX IF NOT EXISTS limit_close_orders_one_armed_per_direction_idx
  ON limit_close_orders(loan_id, COALESCE(trigger_direction, 'above'))
  WHERE status = 'armed';

COMMENT ON INDEX limit_close_orders_one_armed_per_direction_idx IS
  'One armed limit-close order per (loan_id, trigger_direction).
   Allows simultaneous TP + SL on the same loan. Replaces the prior
   single-direction index from migration 025.';
