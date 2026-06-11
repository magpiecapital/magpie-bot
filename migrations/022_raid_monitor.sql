-- Raid monitor — track X (Twitter) influencer accounts, auto-broadcast
-- new posts to @magpietalk with a raid CTA, and tally raid claims.
--
-- Schema goals:
--   - raid_targets        — the influencer accounts we monitor (seeded
--                           with the operator's initial list of 10).
--   - raid_events         — every tweet we've broadcast (one row per
--                           detected new tweet → TG broadcast cycle).
--                           Holds the goal count, the broadcast text,
--                           and the resolution status.
--   - raid_claims         — every "/raided" submission from a TG user.
--                           Loose verification (manual screenshot or
--                           trust-based for v0).
--
-- All three tables are operator-internal but no per-user info is
-- exposed publicly. Claims are surfaced in aggregate (counts) only.

CREATE TABLE IF NOT EXISTS raid_targets (
  id            SERIAL PRIMARY KEY,
  handle        TEXT NOT NULL UNIQUE,        -- lowercase, no @
  display_name  TEXT,                        -- pretty label for messages
  x_user_id     TEXT,                        -- X numeric user id (cached after first lookup)
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by      TEXT,
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS raid_targets_enabled_idx ON raid_targets(enabled) WHERE enabled;

-- Seed the initial 10 handles from the operator (lower-cased here so
-- string comparisons against X API user lookups are case-insensitive).
INSERT INTO raid_targets (handle, display_name, added_by, notes) VALUES
  ('pattyice',       'Pattyice',       'operator', 'initial seed 2026-06-11'),
  ('icedknife',      'IcedKnife',      'operator', 'initial seed 2026-06-11'),
  ('mrpunkdoteth',   'mrpunkdoteth',   'operator', 'initial seed 2026-06-11'),
  ('blknoiz06',      'blknoiz06',      'operator', 'initial seed 2026-06-11'),
  ('notthreadguy',   'notthreadguy',   'operator', 'initial seed 2026-06-11'),
  ('0xsweep',        '0xSweep',        'operator', 'initial seed 2026-06-11'),
  ('jeremybtc',      'Jeremybtc',      'operator', 'initial seed 2026-06-11'),
  ('frankdegods',    'frankdegods',    'operator', 'initial seed 2026-06-11'),
  ('crashiusclay69', 'CrashiusClay69', 'operator', 'initial seed 2026-06-11'),
  ('dipwheeler',     'DipWheeler',     'operator', 'initial seed 2026-06-11')
ON CONFLICT (handle) DO NOTHING;

-- raid_events: one row per detected new tweet + TG broadcast.
CREATE TABLE IF NOT EXISTS raid_events (
  id              SERIAL PRIMARY KEY,
  tweet_id        TEXT NOT NULL UNIQUE,      -- numeric X status id
  handle          TEXT NOT NULL,             -- normalized (lowercase)
  tweet_url       TEXT NOT NULL,
  tweet_text      TEXT,                      -- nullable — we don't always have it
  broadcast_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  goal_claims     INTEGER NOT NULL DEFAULT 10,
  tg_message_id   BIGINT,                    -- the message id of the broadcast in @magpietalk (for follow-up edits)
  tg_chat_id      BIGINT,
  status          TEXT NOT NULL DEFAULT 'live'  -- 'live' | 'goal_hit' | 'closed' | 'failed'
                  CHECK (status IN ('live','goal_hit','closed','failed')),
  closed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS raid_events_status_idx  ON raid_events(status) WHERE status = 'live';
CREATE INDEX IF NOT EXISTS raid_events_handle_idx  ON raid_events(handle, broadcast_at DESC);

-- raid_claims: TG user attestation that they raided. v0 is trust-based
-- (operator can moderate). Future: parse a screenshot via OCR or verify
-- via X API engagement-counts on the tweet itself.
CREATE TABLE IF NOT EXISTS raid_claims (
  id             SERIAL PRIMARY KEY,
  raid_event_id  INTEGER NOT NULL REFERENCES raid_events(id) ON DELETE CASCADE,
  tg_user_id     BIGINT NOT NULL,
  tg_username    TEXT,
  tg_chat_id     BIGINT,
  claimed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evidence_url   TEXT,         -- optional screenshot link or quote-reply URL
  status         TEXT NOT NULL DEFAULT 'counted'
                 CHECK (status IN ('counted', 'rejected')),
  -- Idempotent per (event, user) — one user can only claim once per raid.
  UNIQUE (raid_event_id, tg_user_id)
);

CREATE INDEX IF NOT EXISTS raid_claims_event_idx ON raid_claims(raid_event_id, status);
