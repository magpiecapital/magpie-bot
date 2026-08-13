-- 089 — Token-catalog → @MagpieLoans X announcement reconciliation state.
--
-- The announcer worker (services/token-catalog-announcer.js) diffs the live
-- supported_mints.enabled set against this table and tweets on every
-- add (disabled→enabled) / remove (enabled→disabled) transition, then
-- upserts the new state. This reconciliation pattern catches EVERY catalog
-- change — the RWA screener's auto-add/auto-disable AND any manual /tier or
-- admin change — so the X feed always matches the /tokens page (protocol
-- uniformity).
--
-- IDEMPOTENCY: announcing only happens on a recorded state transition, and
-- the row is upserted in the same pass — so a crash/restart never re-tweets
-- a change already announced. The FIRST run (empty table) seeds every mint
-- silently (last_change_type='seed'), so deploying this never tweet-storms
-- the existing catalog; only changes AFTER the seed are announced.

CREATE TABLE IF NOT EXISTS token_catalog_announce_state (
  mint               TEXT PRIMARY KEY,
  symbol             TEXT,
  category           TEXT,
  last_enabled       BOOLEAN     NOT NULL,
  last_change_type   TEXT,                 -- 'seed' | 'added' | 'removed' | 'seed_overflow' | '*_failed'
  last_announced_at  TIMESTAMPTZ,          -- set only when an add/remove was actually tweeted
  last_tweet_id      TEXT,
  seeded_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast lookup of rows that still need an announcement retry (failed posts).
CREATE INDEX IF NOT EXISTS idx_token_catalog_announce_change
  ON token_catalog_announce_state (last_change_type);
