-- migration 097: collectible submissions — the durable record behind the
-- public vetting gate at magpie.capital/collectibles#submit.
--
-- Design notes, because the shape here is deliberate:
--
--  1. ONE ROW PER ATTEMPT. We do NOT upsert on (grader, cert). If the same
--     slab is submitted twice we want both rows — a cert appearing under two
--     different wallets is a real fraud signal (someone claiming a card they
--     don't hold), and collapsing it would destroy the evidence. Dedupe is a
--     read-time concern, not a write-time one.
--
--  2. THE FULL CHECK TRAIL IS STORED. `checks` holds every gate stage and its
--     outcome, and `gate_version` records which revision of the gate produced
--     it. Without the version, a verdict stops being interpretable the moment
--     the gate changes — and this table is meant to stay meaningful for years.
--
--  3. MACHINE VERDICT AND HUMAN STATUS ARE SEPARATE COLUMNS. `verdict` is what
--     the deterministic gate returned and is never edited. `status` is the
--     human/licensed-data lifecycle on top of it. Overwriting the machine
--     verdict with a human decision would make the two impossible to audit
--     against each other.
--
--  4. NO RAW PII BEYOND WHAT THE USER TYPED. We store a SALTED HASH of the IP
--     and user-agent for abuse detection, never the raw values. `contact` is
--     optional and user-supplied. Nothing here is served publicly — the site
--     only ever returns a caller their OWN rows, and only the public columns.
--
--  5. INTERNAL-ONLY COLUMNS are marked below. reviewer_note, ip_hash,
--     ua_hash and flags must never leave the protocol.
CREATE TABLE IF NOT EXISTS collectible_submissions (
  id            BIGSERIAL PRIMARY KEY,

  -- ── who (all optional; a collector can check a card anonymously) ──
  wallet        TEXT,          -- connected Solana wallet, base58
  telegram_id   BIGINT,        -- set when a submission arrives via the bot
  contact       TEXT,          -- user-supplied handle/email, optional

  -- ── what was submitted ──
  grader        TEXT NOT NULL,
  cert          TEXT NOT NULL,
  card          TEXT NOT NULL,
  card_set      TEXT,
  card_year     TEXT,
  grade         TEXT,          -- kept as text: "10", "9.5", or empty for autos
  auto_grade    TEXT,
  platform      TEXT,          -- vaulting platform, empty = not vaulted yet

  -- ── what the deterministic gate decided (never edited) ──
  verdict       TEXT NOT NULL, -- DECLINED | NEEDS_VAULTING | CANDIDATE_REVIEW | PROVISIONAL_TIER_A | PROVISIONAL_TIER_B
  tier          TEXT,          -- A | B | NULL
  checks        JSONB NOT NULL DEFAULT '[]'::jsonb,
  next_steps    JSONB NOT NULL DEFAULT '[]'::jsonb,
  gate_version  TEXT NOT NULL DEFAULT 'v1',

  -- ── human / licensed-data lifecycle on top of the machine verdict ──
  status        TEXT NOT NULL DEFAULT 'submitted', -- submitted | in_review | approved | rejected | withdrawn
  reviewed_at   TIMESTAMPTZ,
  reviewer_note TEXT,          -- INTERNAL ONLY — never served to a user

  -- ── provenance + abuse signals (INTERNAL ONLY) ──
  source        TEXT NOT NULL DEFAULT 'site',
  ip_hash       TEXT,          -- salted hash, never the raw address
  ua_hash       TEXT,
  flags         JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A collector opening their dashboard: "show me my submissions, newest first."
CREATE INDEX IF NOT EXISTS collectible_submissions_wallet_idx
  ON collectible_submissions (wallet, created_at DESC);

-- Cert collision detection — the fraud signal in note 1.
CREATE INDEX IF NOT EXISTS collectible_submissions_cert_idx
  ON collectible_submissions (grader, cert);

-- Operator review queue.
CREATE INDEX IF NOT EXISTS collectible_submissions_status_idx
  ON collectible_submissions (status, created_at DESC);

-- Demand analytics: what are collectors actually asking for, and what are we
-- turning away? The declines are the more valuable half — they map the edge of
-- the book and tell us which categories to underwrite next.
CREATE INDEX IF NOT EXISTS collectible_submissions_verdict_idx
  ON collectible_submissions (verdict, created_at DESC);

-- INTERNAL analytics view. Aggregate only, no PII, safe to hand to the
-- operator or a future data room without exposing any individual submitter.
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
