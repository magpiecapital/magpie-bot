-- limit_close_orders — auto-escalate slippage support.
--
-- Adds optional auto-escalation: when an agent (or, later, a TG user)
-- opts in, the engine bumps slippage_bps up a 1.5x curve on each
-- proceeds-insufficient revert, never exceeding max_slippage_bps_cap.
-- This is what handles the case "trigger hit but the slippage we
-- armed with isn't enough to execute" without ever exceeding the
-- borrower's explicit ceiling.
--
-- New columns:
--   auto_escalate_slippage  — opt-in flag. Default FALSE so existing
--                             TG-armed orders keep exact-slippage behavior.
--   max_slippage_bps_cap    — the hard ceiling the engine MUST NOT
--                             cross. For agent orders this is captured
--                             from agent_delegations.max_slippage_bps
--                             at arm time. For TG orders we can later
--                             let the user pass slip_cap= as a separate
--                             knob. Nullable means "no escalation
--                             allowed" — the engine treats null as
--                             "use slippage_bps exactly, don't move it".
--   initial_slippage_bps    — what the order was armed with. Frozen
--                             at arm time so audit / debugging shows
--                             the original intent regardless of how
--                             many escalations happened.
--   slippage_escalations    — counter for how many times the engine
--                             bumped slippage. Caps out at log_1.5(cap/initial)
--                             but no hard upper bound; failure_count
--                             still terminates the order at
--                             MAX_FAILURE_COUNT.

ALTER TABLE limit_close_orders
  ADD COLUMN IF NOT EXISTS auto_escalate_slippage BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS max_slippage_bps_cap   INTEGER,
  ADD COLUMN IF NOT EXISTS initial_slippage_bps   INTEGER,
  ADD COLUMN IF NOT EXISTS slippage_escalations   INTEGER NOT NULL DEFAULT 0;

-- Cap must be within the global allowable range AND must be ≥ the
-- order's current slippage. Engine never reads max_slippage_bps_cap
-- without checking it's > current slippage_bps, but we belt-and-suspenders
-- this at the schema layer.
ALTER TABLE limit_close_orders
  ADD CONSTRAINT limit_close_orders_cap_in_range
  CHECK (
    max_slippage_bps_cap IS NULL OR
    (max_slippage_bps_cap >= 10 AND max_slippage_bps_cap <= 1000)
  );

-- Initial slippage, if recorded, must match schema bounds too.
ALTER TABLE limit_close_orders
  ADD CONSTRAINT limit_close_orders_initial_slippage_in_range
  CHECK (
    initial_slippage_bps IS NULL OR
    (initial_slippage_bps >= 10 AND initial_slippage_bps <= 1000)
  );

-- Backfill — for any existing armed orders we set initial_slippage_bps
-- = slippage_bps so audit trails make sense. We leave auto_escalate_slippage
-- FALSE and max_slippage_bps_cap NULL on these so the engine's behavior
-- on them is exactly what it is today (no escalation).
UPDATE limit_close_orders
   SET initial_slippage_bps = slippage_bps
 WHERE initial_slippage_bps IS NULL;
