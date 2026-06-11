-- limit_close_orders — fixes from security audit on the three-layer
-- fill-guarantee shipped in migrations 025-028.
--
-- 1. twap_consecutive_failures — a dedicated counter for TWAP-chunk
--    failures, separate from the order-lifetime failure_count. The
--    engine compares this against TWAP_MAX_CHUNK_RETRIES to decide
--    whether to escalate to user intervention. Without a dedicated
--    counter, an order entering TWAP with failure_count=5 from prior
--    single-block escalations would trigger intervention on the FIRST
--    chunk failure (5 >= 2) — false-positive intervention DMs.
--
-- 2. intervention_decline_cooldown_until — when a user taps Wait on
--    an intervention DM, the engine puts the order back to armed and
--    re-evaluates. Without a cooldown the same failure condition
--    triggers another intervention DM within 30 seconds — DM spam.
--    This timestamp gates re-requests so the engine only DMs again
--    after the cooldown window passes.
--
-- 3. NB: 'awaiting_user' + 'twap_in_progress' need to be picked up by
--    the expireOldOrders watchdog so orders past expires_at don't
--    linger in those states. That's a code change in the engine
--    repo (watcher.js) — no schema change needed; just listing here
--    for completeness.

ALTER TABLE limit_close_orders
  ADD COLUMN IF NOT EXISTS twap_consecutive_failures INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS intervention_decline_cooldown_until TIMESTAMPTZ;

-- Backfill is not needed — both default to 0 / NULL which is what the
-- engine treats as "no prior TWAP failures, no cooldown active."
