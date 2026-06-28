-- 088_limit_close_collateral_sold_raw.sql
--
-- CRITICAL fire-execution bug (2026-06-28): the V4 limit-close fire path's
-- authoritative post-fire UPDATE (magpie-limitclose src/execution.js:~1359)
-- writes `collateral_sold_raw`, but that column was never added to
-- limit_close_orders. So every REAL mc_usd auto-sell fire errored with
--   column "collateral_sold_raw" of relation "limit_close_orders" does not exist
-- AFTER the on-chain convert_collateral_slice tx already succeeded — the
-- collateral WAS sold, but the order could not be marked 'fired' and reverted
-- to 'armed' (the tx_signature_repay breadcrumb correctly blocks a re-fire /
-- double-sell via claimOrder, so funds are safe, but the record is stuck and
-- the dashboard mirror is stale). This was latent: the mc=0 precision bug meant
-- mc_usd triggers never fired before, so this UPDATE never ran until now
-- (operator's live $ANSEM order 74 at 73.2M exposed it).
--
-- Fix: add the missing column so the fire path's UPDATE succeeds. NUMERIC to
-- match the other raw-amount columns (it stores the slice amount sold in raw
-- token units). Idempotent.

ALTER TABLE limit_close_orders ADD COLUMN IF NOT EXISTS collateral_sold_raw NUMERIC;
