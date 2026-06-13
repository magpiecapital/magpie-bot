-- migration 052: engine_milestone_flags
--
-- Single-row table for engine milestone flags that the bot needs to
-- fire one-shot operator DMs on. Each row tracks whether a milestone
-- has been celebrated yet. Today it tracks the first V2 (RWA) fire;
-- the schema is shape-stable so future milestones (first $1M lifetime
-- net-to-user, first cross-source-disagreement save, etc.) drop in
-- as additional rows.
--
-- Why a dedicated table instead of governance_config or a generic flags
-- system: governance_config is runtime tuning that operators change,
-- not engine-observed state. The semantics are different — these flags
-- are "the engine saw this happen on this timestamp", not "the
-- operator set this to value X". Keeping them apart prevents accidental
-- governance writes from re-arming a milestone DM.

CREATE TABLE IF NOT EXISTS engine_milestone_flags (
  milestone_key   text        PRIMARY KEY,
  notified_at     timestamptz,
  reference_id    text,        -- e.g. limit_close_orders.id of the fire
  reference_sig   text,        -- e.g. tx signature
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT NOW()
);

INSERT INTO engine_milestone_flags (milestone_key, notes)
VALUES ('first_v2_fire', 'First successful limit-close fire on the V2 (RWA) lending program — celebrated once.')
ON CONFLICT (milestone_key) DO NOTHING;

COMMENT ON TABLE engine_milestone_flags IS
  'One-shot engine milestone flags. Each row is celebrated exactly once
   when the watcher detects the milestone condition + notified_at
   transitions from NULL to NOW().';
