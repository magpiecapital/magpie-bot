-- 086_mint_warming_intents.sql
--
-- "Hot-on-Select" pattern for V4 borrows on non-hot mints.
--
-- Operator-mandated 2026-06-19 PM after $TROLL V4 borrow hit "Markets
-- warming up — try again in ~20 seconds." Strategic question: how do
-- we support V4 borrows on cold/inactive mints without paying $$$ to
-- keep all 175 enabled mints continuously attested?
--
-- Answer: when the site dashboard sees the user open the V4 exit
-- picker for ANY mint, it POSTs /api/v1/v4/warm-mint. The bot inserts
-- a row here with a 10-min TTL. The V4 continuous-attestation loop's
-- SQL filter UNIONs this table in — so the mint is attested for the
-- 10-min user-shopping window even if it's cold-tier. After 10 min
-- of no borrow, the row expires and continuous attestation drops it.
--
-- This converts "cold mint can't borrow V4" into "user clicks V4 →
-- 1-5 min natural review time → samples accumulate → borrow ready."
--
-- See [[feedback_v4_loan_lifecycle_zero_errors_mandate]] +
-- [[feedback_borrow_conversion_must_be_world_class]] for the reliability
-- mandate this closes.

CREATE TABLE IF NOT EXISTS mint_warming_intents (
  mint           TEXT PRIMARY KEY,
  requested_by   TEXT,                                -- 'site' / 'tg' / 'agent_x402'
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
  hit_count      INT NOT NULL DEFAULT 1               -- bumped on each re-ping
);

CREATE INDEX IF NOT EXISTS idx_mint_warming_intents_expires
  ON mint_warming_intents (expires_at);

-- Periodic cleanup: drop rows that expired > 30 min ago (keep recent
-- expired rows briefly for diagnostic purposes). Worker runs every 15
-- min from the bot side.
