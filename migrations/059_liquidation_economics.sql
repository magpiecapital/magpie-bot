-- migration 059: liquidation_economics — per-default profit accounting.
--
-- WHY THIS EXISTS
-- ───────────────
-- Operator-stated policy as of 2026-06-14: when a non-$MAGPIE
-- collateralized loan defaults, the protocol's NET PROFIT (sale
-- proceeds minus principal paid out) is allocated to the rewards
-- distribution pools using the post-MGP-001 split:
--
--   70% → $MAGPIE holder rewards
--   10% → LP loyalty pool
--   10% → referrers (or rolls back to holders if no referrer)
--   10% → protocol reserve
--
-- When a $MAGPIE-collateralized loan defaults, the seized $MAGPIE
-- gets burned instead — separate row state for accounting.
--
-- This Phase 1 schema is data-tracking ONLY. No fund-moving code
-- references it yet. The watcher in src/services/liquidation-economics-watcher.js
-- populates rows when it detects the operator selling seized
-- collateral on-chain. Phase 2 will wire the actual distribution.
--
-- WHY EACH COLUMN
-- ───────────────
-- principal_lent_lamports          — what the protocol disbursed to the borrower (net of origination fee)
-- principal_with_fee_lamports      — the full loan amount including the origination fee retained
-- collateral_seized_raw            — total collateral the program transferred to the lender at liquidation
-- lender_share_raw                 — collateral after the keeper bounty (typically 95%)
-- keeper_bounty_raw                — collateral the keeper took
-- sale_tx_sig / sale_proceeds_lamports / sale_detected_at
--                                  — populated by the watcher when it identifies the matching sale tx
-- net_profit_lamports              — sale_proceeds - principal_lent. Can be negative (a loss)
-- distribution_status              — enum-shaped TEXT, see check constraint
-- holder/lp_loyalty/referrer/protocol_reserve_share_lamports
--                                  — pre-computed splits for reference; actual distribution happens
--                                    in Phase 2 against these values
-- referrer_user_id                 — borrower's referrer at liquidation time, if any (rolls to holders if null)
-- magpie_burn_amount_raw / magpie_burn_tx_sig
--                                  — populated when $MAGPIE collateral is burned instead of sold
--
-- IDEMPOTENCY
-- ───────────
-- UNIQUE (loan_id) — at most one row per loan. The watcher uses
-- INSERT ... ON CONFLICT DO NOTHING to gracefully no-op on re-runs.
-- Subsequent updates (e.g. backfilling sale_tx_sig) use UPDATE with
-- WHERE sale_tx_sig IS NULL to avoid clobbering already-recorded
-- proceeds — preserving the audit trail.

CREATE TABLE IF NOT EXISTS liquidation_economics (
  id                            BIGSERIAL PRIMARY KEY,
  loan_id                       BIGINT      NOT NULL REFERENCES loans(id),
  borrower_wallet               TEXT        NOT NULL,
  collateral_mint               TEXT        NOT NULL,
  collateral_symbol             TEXT,

  principal_lent_lamports       BIGINT      NOT NULL,
  principal_with_fee_lamports   BIGINT      NOT NULL,

  collateral_seized_raw         NUMERIC(40, 0) NOT NULL,
  lender_share_raw              NUMERIC(40, 0),
  keeper_bounty_raw             NUMERIC(40, 0),

  sale_tx_sig                   TEXT,
  sale_proceeds_lamports        BIGINT,
  sale_detected_at              TIMESTAMPTZ,

  net_profit_lamports           BIGINT,

  distribution_status           TEXT NOT NULL DEFAULT 'pending_sale'
    CHECK (distribution_status IN (
      'pending_sale',          -- waiting for the operator to sell the seized collateral
      'awaiting_distribution', -- sale detected, profit computed, not yet distributed (Phase 2 picks up)
      'distributed',           -- Phase 2 has routed the splits to the pools
      'magpie_burn_pending',   -- $MAGPIE collateral, awaiting burn
      'magpie_burned',         -- $MAGPIE seized + burned on-chain
      'loss',                  -- sale proceeds were less than principal — no distribution, recorded for audit
      'manual_skip'            -- operator opted out (e.g. testnet liquidation, internal loan)
    )),

  -- Pre-computed split amounts. Stored at record time so the audit
  -- trail is immutable even if MGP-XXX changes the bps later.
  holder_share_lamports         BIGINT,
  lp_loyalty_share_lamports     BIGINT,
  referrer_share_lamports       BIGINT,
  protocol_reserve_share_lamports BIGINT,

  referrer_user_id              BIGINT,

  magpie_burn_amount_raw        NUMERIC(40, 0),
  magpie_burn_tx_sig            TEXT,

  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT liquidation_economics_one_per_loan UNIQUE (loan_id)
);

-- Hot-path access patterns:
--   1. /stats: SUM(net_profit_lamports) WHERE distribution_status != 'loss' AND sale_detected_at IS NOT NULL
--   2. /stats: same SUM filtered by sale_detected_at > NOW() - INTERVAL '24 hours'
--   3. watcher: pending_sale rows by oldest, polling per collateral_mint
--   4. distribution (Phase 2): awaiting_distribution rows, FIFO
CREATE INDEX IF NOT EXISTS liquidation_economics_status_idx
  ON liquidation_economics(distribution_status, sale_detected_at);
CREATE INDEX IF NOT EXISTS liquidation_economics_sale_at_idx
  ON liquidation_economics(sale_detected_at DESC)
  WHERE sale_detected_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS liquidation_economics_collateral_idx
  ON liquidation_economics(collateral_mint, distribution_status);

COMMENT ON TABLE liquidation_economics IS
  'Per-default profit accounting (2026-06-14 policy). One row per
   liquidated loan. Tracks principal vs sale proceeds, the pre-computed
   distribution splits (70/10/10/10 from MGP-001, with referrer slice
   rolling to holders when no referrer), and $MAGPIE burns. Watcher
   populates rows; Phase 2 will use them to actually route funds. The
   sale_tx_sig identifies the on-chain Solana signature where the
   operator sold the seized collateral — that''s the authoritative
   proceeds source.';
