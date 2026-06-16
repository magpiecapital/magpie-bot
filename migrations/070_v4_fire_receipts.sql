-- migration 070: v4_fire_receipts forensic-audit table.
--
-- Every confirmed V4 convert_collateral_slice fire writes one row.
-- Captures pre/post state, Jupiter route used, timing, and the
-- specific retry-path branch the engine took. This is the surgical
-- audit trail the operator needs to confidently sign off on V4.
--
-- T9 (2026-06-16). Idempotent: only ever inserted by the engine post-
-- confirmation; engine is single-process so no concurrent inserts.

CREATE TABLE IF NOT EXISTS v4_fire_receipts (
  id                          BIGSERIAL PRIMARY KEY,
  order_id                    BIGINT NOT NULL,
  loan_id                     BIGINT NOT NULL,
  signature                   TEXT NOT NULL UNIQUE,
  program_id                  TEXT NOT NULL,
  collateral_mint             TEXT NOT NULL,
  -- Fire mechanics
  slice_bps                   INTEGER NOT NULL,
  slice_amount_raw            NUMERIC(40, 0) NOT NULL,
  sol_received_gross_lamports NUMERIC(20, 0) NOT NULL,
  protocol_fee_lamports       NUMERIC(20, 0) NOT NULL,
  sol_received_net_lamports   NUMERIC(20, 0) NOT NULL,
  remaining_collateral_raw    NUMERIC(40, 0) NOT NULL,
  total_sol_proceeds_lamports NUMERIC(20, 0) NOT NULL,
  auto_sells_fired            INTEGER NOT NULL,
  -- Routing telemetry
  jupiter_dexes_used          TEXT[],   -- e.g. ['SolFi V2', 'GoonFi V2']
  jupiter_route_failure_retry BOOLEAN NOT NULL DEFAULT FALSE,
  jupiter_excluded_dexes      TEXT[],   -- non-null when route_failure_retry=true
  jupiter_quoted_out_lamports NUMERIC(20, 0),
  jupiter_min_out_lamports    NUMERIC(20, 0) NOT NULL,
  slippage_quoted_actual_bps  INTEGER,  -- (quoted - actual_received) / quoted * 10000
  -- Timing (ms epochs)
  preflight_sim_cu            INTEGER,
  fire_started_at             TIMESTAMPTZ NOT NULL,
  broadcast_at                TIMESTAMPTZ,
  confirmed_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Source
  fired_by_trigger_kind       TEXT,
  fired_by_trigger_value      NUMERIC(40, 0),
  fired_by_source             TEXT      -- 'tg' | 'site' | 'agent_x402'
);

CREATE INDEX IF NOT EXISTS idx_v4_fire_receipts_loan_id
  ON v4_fire_receipts (loan_id, confirmed_at DESC);
CREATE INDEX IF NOT EXISTS idx_v4_fire_receipts_order_id
  ON v4_fire_receipts (order_id);
CREATE INDEX IF NOT EXISTS idx_v4_fire_receipts_confirmed_at
  ON v4_fire_receipts (confirmed_at DESC);
