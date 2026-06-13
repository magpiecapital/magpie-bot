-- migration 043: engine_heartbeats table for cross-service liveness signal
--
-- Pairs with magpiecapital/magpie-limitclose PR #9. The engine writes
-- one row per tick (UPSERT id=1). The bot polls and DMs the operator
-- if last_tick_at goes stale > 5 min.
--
-- Single-row design (id=1) instead of an append-only log: we only need
-- "alive in the last few seconds?" — historical heartbeats are noise.
-- If the engine ships multiple watcher kinds in the future, each gets
-- a distinct id + service name.
--
-- LIMIT_CLOSE_ENGINE_AUDIT.md section 3 flagged this as missing.

CREATE TABLE IF NOT EXISTS engine_heartbeats (
  id                INTEGER     PRIMARY KEY,
  service           TEXT        NOT NULL,
  last_tick_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_tick_status  TEXT        NOT NULL DEFAULT 'ok',
  armed_count       INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE engine_heartbeats IS
  'Liveness signal for external engines (e.g. limit_close_watcher in
   magpiecapital/magpie-limitclose). Engine UPSERTs id=1 each tick;
   bot watcher reads last_tick_at and alerts if stale > 5 min. Single
   row per service — historical heartbeats are noise, this is purely
   the "are you alive?" check.';
