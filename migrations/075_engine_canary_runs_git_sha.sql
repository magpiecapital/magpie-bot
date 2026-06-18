-- Add git_sha column to engine_canary_runs so canary alerts can be
-- tied to the specific build that produced them.
--
-- 2026-06-18 PM: shipped after an incident where engine PR #51 (the
-- RWA cross-source skip) was on main but the production engine had not
-- picked it up — every SPCX canary kept FAIL-ing for hours because the
-- deployed binary didn't have the skip. Without the SHA in the row,
-- there was no way to tell from the failure alone that prod was stale.
--
-- Engine writes RAILWAY_GIT_COMMIT_SHA (Railway-auto-populated) or
-- "local" for dev runs. Column is nullable for backward compat —
-- rows recorded before this column lands stay NULL.

ALTER TABLE engine_canary_runs
  ADD COLUMN IF NOT EXISTS git_sha TEXT;

CREATE INDEX IF NOT EXISTS idx_engine_canary_runs_git_sha_run_at
  ON engine_canary_runs (git_sha, run_at DESC);
