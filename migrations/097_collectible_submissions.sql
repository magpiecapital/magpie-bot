-- migration 097: collectible submissions — durable record behind the vetting
-- gate at magpie.capital/collectibles#submit.
--
-- ⚠️ THIS MIGRATION HEALS A TABLE THAT ALREADY EXISTS IN PRODUCTION.
--
-- The first version of the site route created this table itself with an inline
-- CREATE TABLE. That was off-pattern, and it left production holding a DIFFERENT
-- shape to the one intended here: no wallet/checks/next_steps/gate_version/
-- status/flags columns, a legacy `year` and `detail` column, and — worst — a
-- UNIQUE index on (grader, cert).
--
-- Two things follow, and both are why this file is ALTER-based rather than a
-- plain CREATE:
--
--   1. `CREATE TABLE IF NOT EXISTS` silently no-ops against the legacy table, so
--      every column below has to be added explicitly or the site's INSERT keeps
--      failing (it does — the route swallows DB errors so the collector still
--      gets an answer, which is right, but it means the breakage was silent).
--
--   2. The legacy UNIQUE index directly contradicts the design: we keep ONE ROW
--      PER ATTEMPT and never upsert on (grader, cert), because the same cert
--      appearing under two different wallets is a fraud signal and collapsing it
--      destroys the evidence. With a UNIQUE index in place the second attempt
--      would error instead of being recorded. It is dropped and recreated
--      non-unique below.
--
-- Design notes for the shape itself:
--   - The full check trail is stored alongside `gate_version`. Without the
--     version a verdict stops being interpretable the moment the gate changes,
--     and this table is meant to stay meaningful for years.
--   - Machine `verdict` and human `status` are SEPARATE columns. `verdict` is
--     never edited, so the two can always be audited against each other.
--   - No raw PII: `ip_hash`/`ua_hash` are salted hashes, never the raw values.
--   - INTERNAL ONLY, never served to a user: reviewer_note, ip_hash, ua_hash,
--     flags.

-- Fresh environments get the whole thing in one shot.
CREATE TABLE IF NOT EXISTS collectible_submissions (
  id            BIGSERIAL PRIMARY KEY,
  wallet        TEXT,
  telegram_id   BIGINT,
  contact       TEXT,
  grader        TEXT NOT NULL,
  cert          TEXT NOT NULL,
  card          TEXT NOT NULL,
  card_set      TEXT,
  card_year     TEXT,
  grade         TEXT,
  auto_grade    TEXT,
  platform      TEXT,
  verdict       TEXT NOT NULL,
  tier          TEXT,
  checks        JSONB NOT NULL DEFAULT '[]'::jsonb,
  next_steps    JSONB NOT NULL DEFAULT '[]'::jsonb,
  gate_version  TEXT NOT NULL DEFAULT 'v1',
  status        TEXT NOT NULL DEFAULT 'submitted',
  reviewed_at   TIMESTAMPTZ,
  reviewer_note TEXT,
  source        TEXT NOT NULL DEFAULT 'site',
  ip_hash       TEXT,
  ua_hash       TEXT,
  flags         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Heal the legacy shape. Every one of these is a no-op where the column already
-- exists, so this is safe on both fresh and legacy databases.
ALTER TABLE collectible_submissions ADD COLUMN IF NOT EXISTS wallet        TEXT;
ALTER TABLE collectible_submissions ADD COLUMN IF NOT EXISTS telegram_id   BIGINT;
ALTER TABLE collectible_submissions ADD COLUMN IF NOT EXISTS card_year     TEXT;
ALTER TABLE collectible_submissions ADD COLUMN IF NOT EXISTS checks        JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE collectible_submissions ADD COLUMN IF NOT EXISTS next_steps    JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE collectible_submissions ADD COLUMN IF NOT EXISTS gate_version  TEXT NOT NULL DEFAULT 'v1';
ALTER TABLE collectible_submissions ADD COLUMN IF NOT EXISTS status        TEXT NOT NULL DEFAULT 'submitted';
ALTER TABLE collectible_submissions ADD COLUMN IF NOT EXISTS reviewed_at   TIMESTAMPTZ;
ALTER TABLE collectible_submissions ADD COLUMN IF NOT EXISTS reviewer_note TEXT;
ALTER TABLE collectible_submissions ADD COLUMN IF NOT EXISTS source        TEXT NOT NULL DEFAULT 'site';
ALTER TABLE collectible_submissions ADD COLUMN IF NOT EXISTS ip_hash       TEXT;
ALTER TABLE collectible_submissions ADD COLUMN IF NOT EXISTS ua_hash       TEXT;
ALTER TABLE collectible_submissions ADD COLUMN IF NOT EXISTS flags         JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE collectible_submissions ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Carry the legacy columns across before they go. `detail` held {checks, next}.
-- The information_schema guards MUST be qualified with current_schema(): without
-- it they match a same-named table in ANY schema, so a re-run reports the legacy
-- column as still present and then fails updating a column that's already gone.
-- Caught by running this migration three times in a scratch schema.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'collectible_submissions' AND column_name = 'year') THEN
    EXECUTE 'UPDATE collectible_submissions SET card_year = year WHERE card_year IS NULL AND year IS NOT NULL';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'collectible_submissions' AND column_name = 'detail') THEN
    EXECUTE $q$
      UPDATE collectible_submissions
         SET checks     = COALESCE(detail->'checks', '[]'::jsonb),
             next_steps = COALESCE(detail->'next',   '[]'::jsonb)
       WHERE detail IS NOT NULL
         AND checks = '[]'::jsonb
    $q$;
  END IF;
END $$;

ALTER TABLE collectible_submissions DROP COLUMN IF EXISTS year;
ALTER TABLE collectible_submissions DROP COLUMN IF EXISTS detail;

-- The legacy UNIQUE index has to go: one row per attempt is the whole point.
DROP INDEX IF EXISTS collectible_submissions_cert_idx;

-- A collector opening their dashboard: "my submissions, newest first."
CREATE INDEX IF NOT EXISTS collectible_submissions_wallet_idx
  ON collectible_submissions (wallet, created_at DESC);

-- Cert collision detection — deliberately NOT unique.
CREATE INDEX IF NOT EXISTS collectible_submissions_cert_idx
  ON collectible_submissions (grader, cert);

-- Operator review queue.
CREATE INDEX IF NOT EXISTS collectible_submissions_status_idx
  ON collectible_submissions (status, created_at DESC);

-- Demand analytics: what collectors ask for, and what we turn away. The
-- declines are the more valuable half — they map the edge of the book.
CREATE INDEX IF NOT EXISTS collectible_submissions_verdict_idx
  ON collectible_submissions (verdict, created_at DESC);

-- INTERNAL analytics view. Aggregate only, no PII, safe to hand to the operator
-- or a future data room without exposing any individual submitter.
-- NOTE: this reads live rows, so it changes as retention reduces them. The
-- DURABLE demand history is `collectible_submission_daily` (migration 098),
-- which the retention job writes before it reduces anything.
CREATE OR REPLACE VIEW collectible_submission_demand AS
SELECT
  date_trunc('day', created_at)                       AS day,
  verdict,
  COALESCE(tier, '-')                                 AS tier,
  COALESCE(NULLIF(platform, ''), 'not vaulted')       AS platform,
  COUNT(*)                                            AS submissions,
  COUNT(DISTINCT wallet) FILTER (WHERE wallet IS NOT NULL AND wallet <> '') AS wallets
FROM collectible_submissions
GROUP BY 1, 2, 3, 4;
