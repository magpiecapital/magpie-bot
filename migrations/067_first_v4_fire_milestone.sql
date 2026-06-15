-- migration 067: seed milestone flags for the V4 fire watcher.
--
-- Mirrors migration 063 (V3 milestones) for V4. The bot's
-- limit-close-first-v4-fire-watcher service polls these flags and
-- sets notified_at exactly once when the FIRST V4 fire (success or
-- failure) lands. Without these rows the watcher no-ops because
-- `SELECT notified_at WHERE milestone_key=...` returns no row.
--
-- Idempotent: INSERT ON CONFLICT DO NOTHING. Re-applying after a
-- successful V4 fire (notified_at populated) leaves the recorded
-- timestamps intact.

INSERT INTO engine_milestone_flags (milestone_key, notified_at, reference_id)
VALUES
  ('first_v4_fire', NULL, NULL),
  ('first_v4_fire_failure', NULL, NULL)
ON CONFLICT (milestone_key) DO NOTHING;
