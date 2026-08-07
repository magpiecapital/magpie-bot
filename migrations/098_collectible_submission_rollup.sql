-- migration 098: persist the collectible submission demand rollup.
--
-- WHY THIS EXISTS, and it's the whole point:
--
-- Migration 097 exposed demand through `collectible_submission_demand`, a VIEW
-- over the base table. The retention policy (design repo doc 05) then says
-- declined submissions are reduced after 24 months.
--
-- Those two facts are in direct conflict. A view computes from the rows that
-- still exist, so the moment retention deletes an old declined row, that day's
-- demand history silently changes underneath us — and the declines are the
-- MORE valuable half of the signal, because they map the edge of the book.
-- Retention would have been quietly destroying the asset it was written to
-- protect.
--
-- So the aggregate has to be a real table that the retention job writes to
-- BEFORE it reduces anything. Rows are ephemeral; the demand history is not.
CREATE TABLE IF NOT EXISTS collectible_submission_daily (
  day          DATE   NOT NULL,
  verdict      TEXT   NOT NULL,
  tier         TEXT   NOT NULL DEFAULT '-',
  platform     TEXT   NOT NULL DEFAULT 'not vaulted',
  submissions  INTEGER NOT NULL DEFAULT 0,
  wallets      INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, verdict, tier, platform)
);

CREATE INDEX IF NOT EXISTS collectible_submission_daily_day_idx
  ON collectible_submission_daily (day DESC);

-- Backfill from whatever is currently in the base table, so the rollup starts
-- complete rather than from today. Safe to re-run.
INSERT INTO collectible_submission_daily (day, verdict, tier, platform, submissions, wallets)
SELECT
  date_trunc('day', created_at)::date,
  verdict,
  COALESCE(NULLIF(tier, ''), '-'),
  COALESCE(NULLIF(platform, ''), 'not vaulted'),
  COUNT(*),
  COUNT(DISTINCT wallet) FILTER (WHERE wallet IS NOT NULL AND wallet <> '')
FROM collectible_submissions
GROUP BY 1, 2, 3, 4
ON CONFLICT (day, verdict, tier, platform) DO UPDATE
  SET submissions = EXCLUDED.submissions,
      wallets     = EXCLUDED.wallets,
      updated_at  = NOW();
