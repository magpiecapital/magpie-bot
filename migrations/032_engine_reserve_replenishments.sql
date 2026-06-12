-- migration 032: audit log for engine reserve auto-replenishments.
--
-- The engine's reserve auto-replenishment module (magpie-limitclose
-- src/reserve.js) automatically pulls SOL from a reserve source wallet
-- (env ENGINE_RESERVE_SOURCE_KEYPAIR) into the engine topup wallet
-- (env ENGINE_TOPUP_KEYPAIR) whenever the topup wallet's balance drops
-- below the trigger floor.
--
-- We log every replenishment for ops reconciliation:
--   - Confirms what was transferred and when
--   - Lets the operator audit source-wallet drain over time
--   - Lets the self-monitor build a "X replenishments in last 24h"
--     metric to detect runaway fill volume
--
-- Logging is best-effort in the engine — a failed INSERT here does NOT
-- roll back the on-chain transfer (the SOL is already moved). The audit
-- table is purely observational.
--
-- Why a dedicated table rather than logging into limit_close_orders:
-- replenishments are protocol-level operational events, not per-order
-- events. Joining them onto orders would be artificial.

CREATE TABLE IF NOT EXISTS engine_reserve_replenishments (
  id                     BIGSERIAL PRIMARY KEY,
  transferred_lamports   NUMERIC NOT NULL CHECK (transferred_lamports > 0),
  source_pubkey          TEXT NOT NULL,
  topup_pubkey           TEXT NOT NULL,
  signature              TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Look-ups by recency are the dominant access pattern (audit
-- "last N replenishments" + "replenishments in last 24h").
CREATE INDEX IF NOT EXISTS engine_reserve_replenishments_created_at_idx
  ON engine_reserve_replenishments (created_at DESC);

COMMENT ON TABLE engine_reserve_replenishments IS
  'Audit log for the engine reserve auto-replenishment (src/reserve.js).
   One row per successful SOL transfer from ENGINE_RESERVE_SOURCE_KEYPAIR
   into ENGINE_TOPUP_KEYPAIR. Best-effort insert by the engine — the
   on-chain transfer is the source of truth.';
