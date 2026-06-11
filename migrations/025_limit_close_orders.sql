-- Limit-Close-and-Sell — v1 schema.
--
-- Two tables:
--   1. limit_close_orders  — the order itself, owned by a user, attached to a loan.
--   2. pending_notifications — outbox for DMs the bot needs to send (engine writes,
--                              bot reads + sends + marks delivered).
--
-- Design properties baked into the schema, not just the code:
--   - Status enum is exhaustive; CHECK constraint catches typos.
--   - Trigger value is stored as BIGINT micros (USD * 1e6 or SOL lamports). Integer
--     math everywhere, no float drift in the trigger comparison.
--   - Slippage cap is at 1000 bps (10%) at the DB level. Tighter caps in the
--     command handler can refuse smaller orders; the DB just refuses to store
--     anything pathological.
--   - protocol_fee_bps per-order column (default 100 = 1%). Lets the operator
--     tune fees per-order in extreme cases without a code deploy and gives
--     auditors a clear per-order accounting trail.
--   - Indices target exactly the queries the engine + bot run on the hot path.

CREATE TABLE IF NOT EXISTS limit_close_orders (
  id                          SERIAL PRIMARY KEY,
  user_id                     INTEGER NOT NULL REFERENCES users(id),
  loan_id                     INTEGER NOT NULL REFERENCES loans(id),

  -- Trigger spec
  trigger_kind                TEXT NOT NULL
                              CHECK (trigger_kind IN ('mc_usd','price_usd','price_sol')),
  trigger_value_micro         BIGINT NOT NULL CHECK (trigger_value_micro > 0),

  -- Execution params
  slippage_bps                INTEGER NOT NULL DEFAULT 200
                              CHECK (slippage_bps >= 10 AND slippage_bps <= 1000),
  sell_destination            TEXT NOT NULL DEFAULT 'sol'
                              CHECK (sell_destination IN ('sol','usdc')),
  protocol_fee_bps            INTEGER NOT NULL DEFAULT 100
                              CHECK (protocol_fee_bps >= 0 AND protocol_fee_bps <= 1000),

  -- Optional safety floor — never accept proceeds below this (in destination units)
  min_proceeds_lamports       NUMERIC(20,0),

  -- Lifecycle
  status                      TEXT NOT NULL DEFAULT 'armed'
                              CHECK (status IN ('armed','firing','fired','cancelled','expired','failed')),
  armed_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  firing_started_at           TIMESTAMPTZ,  -- set when claim flips status to 'firing'
  fired_at                    TIMESTAMPTZ,
  expires_at                  TIMESTAMPTZ,  -- nullable — no expiration by default

  -- Source provenance
  source                      TEXT NOT NULL DEFAULT 'tg'
                              CHECK (source IN ('tg','site','agent_x402')),
  source_agent_pubkey         TEXT,  -- nullable; populated for source='agent_x402'

  -- Execution receipts
  tx_signature_repay          TEXT,
  tx_signature_swap           TEXT,
  proceeds_lamports           NUMERIC(20,0),     -- pre-fee
  protocol_fee_lamports       NUMERIC(20,0),     -- = proceeds * protocol_fee_bps / 10000
  net_to_user_lamports        NUMERIC(20,0),     -- = proceeds - protocol_fee - loan_owed_at_fire
  loan_owed_at_fire_lamports  NUMERIC(20,0),     -- snapshot at the moment of execution

  -- Failure / cancellation tracking
  cancellation_reason         TEXT,
  failure_reason              TEXT,
  failure_count               INTEGER NOT NULL DEFAULT 0,  -- retried-then-failed counter

  -- Free-form notes for audit
  notes                       TEXT,

  -- Standard timestamps
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes — every WHERE-clause column the engine and bot run on the hot path.
-- The "armed" partial index is the single most important one: the engine's
-- watcher scans only armed orders every tick. Without this, the watcher
-- degrades to a full table scan once we have thousands of historical rows.
CREATE INDEX IF NOT EXISTS limit_close_orders_armed_idx
  ON limit_close_orders(loan_id, armed_at) WHERE status = 'armed';
CREATE INDEX IF NOT EXISTS limit_close_orders_firing_idx
  ON limit_close_orders(firing_started_at) WHERE status = 'firing';
CREATE INDEX IF NOT EXISTS limit_close_orders_user_idx
  ON limit_close_orders(user_id, status, armed_at DESC);

-- One ARMED order per loan at a time. Multiple historical 'fired'/'cancelled'
-- rows for the same loan are fine. This is the cleanest way to express
-- "user can only have one take-profit on a given loan" — race-safe because
-- the index physically can't permit two armed rows.
CREATE UNIQUE INDEX IF NOT EXISTS limit_close_orders_one_armed_per_loan_idx
  ON limit_close_orders(loan_id) WHERE status = 'armed';

-- Touch updated_at on every UPDATE, no app-side memory needed.
CREATE OR REPLACE FUNCTION limit_close_orders_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_limit_close_orders_updated_at ON limit_close_orders;
CREATE TRIGGER trg_limit_close_orders_updated_at
  BEFORE UPDATE ON limit_close_orders
  FOR EACH ROW EXECUTE FUNCTION limit_close_orders_touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- pending_notifications: outbox so the engine (in a separate private repo)
-- can write notifications and the bot (this repo) picks them up + DMs.
-- Decouples the engine from the TG bot library entirely.
--
-- Delivery semantics:
--   - The bot polls every few seconds for status='pending'.
--   - Atomic claim via UPDATE WHERE status='pending' RETURNING — prevents
--     two bot instances from sending duplicate DMs.
--   - On TG failure: increment attempt_count, leave status='pending', retry
--     up to MAX_ATTEMPTS (in bot config). On terminal failure mark 'failed'.

CREATE TABLE IF NOT EXISTS pending_notifications (
  id                INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  channel           TEXT NOT NULL DEFAULT 'tg'
                    CHECK (channel IN ('tg','site_alert')),
  kind              TEXT NOT NULL,         -- 'limit_close_armed' | 'limit_close_fired' | 'limit_close_failed' | etc.
  payload           JSONB NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sending','sent','failed')),
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pending_notifications_pending_idx
  ON pending_notifications(created_at) WHERE status = 'pending';
