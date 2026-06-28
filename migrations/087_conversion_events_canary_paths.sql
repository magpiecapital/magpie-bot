-- 087_conversion_events_canary_paths.sql
--
-- Bug fix (2026-06-28): the borrow-canary (src/services/borrow-canary.js) and
-- x402-path-canary (src/services/x402-path-canary.js) record their synthetic
-- probe results to conversion_events with path='borrow_canary' and
-- path='x402_path_canary'. But the original CHECK constraint (migration 083)
-- only allowed the four real user paths ('borrow','arm','fire','repay'), so
-- EVERY canary tick violated conversion_events_path_check and its row was
-- silently dropped — flooding the bot logs with
--   [conv-tracker] DB write failed (swallowing): ... violates check constraint
--                  "conversion_events_path_check"
-- and losing all canary conversion telemetry.
--
-- Fix: widen the allowed set to include the two canary paths. Idempotent
-- (DROP IF EXISTS + ADD) so it is safe to re-run and safe if the constraint
-- was already widened out-of-band.

ALTER TABLE conversion_events DROP CONSTRAINT IF EXISTS conversion_events_path_check;
ALTER TABLE conversion_events ADD CONSTRAINT conversion_events_path_check
  CHECK (path IN ('borrow', 'arm', 'fire', 'repay', 'borrow_canary', 'x402_path_canary'));
