-- limit_close_orders — fill-guarantee layers (preflight + TWAP + intervention).
--
-- This migration adds the columns + state-machine extensions for three
-- "ensure it fills" mechanisms layered on top of the existing
-- auto-escalate behavior:
--
--   Layer 1 (pre-flight): the bot's internal arm endpoint runs a
--     Jupiter quote at current liquidity BEFORE accepting an order.
--     If the quote can't clear at the user's slippage, we reject with
--     a suggested slippage. preflight_* columns store what we saw at
--     arm time for audit + later comparison ("liquidity got worse").
--
--   Layer 2 (TWAP): when the engine's single-block sell can't clear
--     even at the cap, it falls back to slicing the position across
--     N chunks. Each chunk has less price impact, raising the chance
--     that ALL chunks fit within the slippage cap.
--
--     New status 'twap_in_progress' sits between 'firing' and 'fired'.
--     The watcher resumes TWAP across restarts by reading
--     twap_chunks_completed + the user's ATA balance.
--
--   Layer 3 (intervention): if both single-block and TWAP fail at the
--     cap, the engine flips the order to 'awaiting_user' (terminal
--     from the engine's perspective until the user responds). The
--     bot DMs the borrower with an inline keyboard offering YES
--     (allow new higher cap), NO (keep trying at current cap), or
--     CANCEL. A timeout cron flips stale interventions to 'failed'.
--
-- All transitions are guarded by status enum CHECK + by SQL UPDATE
-- conditions in the engine that ensure we only ever move from one
-- specific state to the next. The state machine is auditable from
-- the row alone.

ALTER TABLE limit_close_orders
  -- ── Layer 1: pre-flight ─────────────────────────────────────────
  -- The Jupiter-quoted slippage that would have actually cleared at
  -- arm time. If the user's slippage_bps was insufficient, the arm
  -- endpoint returns this as the suggested floor and refuses to insert
  -- — so the row never reaches the DB in that case. We do store it
  -- for orders that pass arm so we can later detect "liquidity has
  -- gotten WORSE since you armed."
  ADD COLUMN IF NOT EXISTS preflight_slippage_quoted_bps INT,
  ADD COLUMN IF NOT EXISTS preflight_quoted_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS preflight_proceeds_lamports   NUMERIC(20,0),

  -- ── Layer 2: TWAP state ─────────────────────────────────────────
  ADD COLUMN IF NOT EXISTS twap_chunks_total             INT,
  ADD COLUMN IF NOT EXISTS twap_chunks_completed         INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS twap_proceeds_accumulated_lamports NUMERIC(20,0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS twap_last_chunk_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS twap_started_at               TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS twap_tx_signatures            TEXT[],

  -- ── Layer 3: user intervention ──────────────────────────────────
  -- intervention_state is a sub-state of status='awaiting_user'. Even
  -- if status flips back (engine retries after approval), the
  -- intervention_state row stays as the historical audit of what the
  -- user said.
  ADD COLUMN IF NOT EXISTS intervention_state TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS intervention_requested_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS intervention_suggested_slippage_bps INT,
  ADD COLUMN IF NOT EXISTS intervention_response_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS intervention_response             TEXT,
  ADD COLUMN IF NOT EXISTS intervention_notification_id      INT,
  ADD COLUMN IF NOT EXISTS intervention_count                INT NOT NULL DEFAULT 0;

-- Status enum extension. Order matters: we DROP the existing CHECK
-- before re-adding with the wider set. IF EXISTS guards against
-- a fresh DB that doesn't have the old constraint yet.
ALTER TABLE limit_close_orders DROP CONSTRAINT IF EXISTS limit_close_orders_status_check;
ALTER TABLE limit_close_orders
  ADD CONSTRAINT limit_close_orders_status_check
  CHECK (status IN (
    'armed',
    'firing',
    'twap_in_progress',
    'awaiting_user',
    'fired',
    'partial_fired',
    'cancelled',
    'expired',
    'failed'
  ));

-- intervention_state CHECK. Enforces the small enum at the storage
-- layer so a typo in the engine or bot can't push the row into a
-- state the rest of the system doesn't understand.
ALTER TABLE limit_close_orders DROP CONSTRAINT IF EXISTS limit_close_orders_intervention_state_check;
ALTER TABLE limit_close_orders
  ADD CONSTRAINT limit_close_orders_intervention_state_check
  CHECK (intervention_state IN (
    'none', 'requested', 'approved', 'declined', 'timed_out'
  ));

-- TWAP coherence: if twap_chunks_total is non-null, twap_chunks_completed
-- must be in [0, twap_chunks_total]. Defense in depth — the engine
-- enforces this in UPDATE clauses but the schema enforces it too so a
-- buggy ad-hoc UPDATE can't corrupt the row.
ALTER TABLE limit_close_orders DROP CONSTRAINT IF EXISTS limit_close_orders_twap_completed_check;
ALTER TABLE limit_close_orders
  ADD CONSTRAINT limit_close_orders_twap_completed_check
  CHECK (
    twap_chunks_total IS NULL OR
    (twap_chunks_completed >= 0 AND twap_chunks_completed <= twap_chunks_total)
  );

-- intervention_response is constrained to the three options users pick
-- + a 'timeout' sentinel set by the cron. NULL means "not yet responded".
ALTER TABLE limit_close_orders DROP CONSTRAINT IF EXISTS limit_close_orders_intervention_response_check;
ALTER TABLE limit_close_orders
  ADD CONSTRAINT limit_close_orders_intervention_response_check
  CHECK (
    intervention_response IS NULL OR
    intervention_response IN ('approve', 'decline', 'cancel', 'timeout')
  );

-- New partial index — TWAP watcher scans these. Same idea as the armed
-- partial index: keeps the hot-path scan O(twap_in_flight) not O(all_orders).
CREATE INDEX IF NOT EXISTS limit_close_orders_twap_idx
  ON limit_close_orders(twap_last_chunk_at)
  WHERE status = 'twap_in_progress';

-- New partial index — intervention timeout cron scans these.
CREATE INDEX IF NOT EXISTS limit_close_orders_awaiting_user_idx
  ON limit_close_orders(intervention_requested_at)
  WHERE status = 'awaiting_user';

-- Backfill preflight column from any data we have. For pre-feature rows
-- nothing to backfill; columns stay NULL which the rest of the system
-- treats as "no pre-flight data, behave as before".
