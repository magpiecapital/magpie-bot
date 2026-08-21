-- 104_agent_surface_canary_path.sql
--
-- Same bug class as migration 087: the agent-surface canary
-- (src/services/agent-surface-canary.js, added 2026-08-21) records its
-- synthetic discovery-surface probe results to conversion_events with
-- path='agent_surface_canary', but the CHECK constraint (087) only allowed
-- the borrow + two existing canary paths. So EVERY agent-surface canary tick
-- violated conversion_events_path_check and its row was silently dropped —
-- the canary's ALERTS still fire (that logic runs after the swallowed insert)
-- but its telemetry was lost.
--
-- Fix: widen the allowed set to include 'agent_surface_canary'. Idempotent
-- (DROP IF EXISTS + ADD), safe to re-run.

ALTER TABLE conversion_events DROP CONSTRAINT IF EXISTS conversion_events_path_check;
ALTER TABLE conversion_events ADD CONSTRAINT conversion_events_path_check
  CHECK (path IN ('borrow', 'arm', 'fire', 'repay', 'borrow_canary', 'x402_path_canary', 'agent_surface_canary'));
