-- Operator-designated trusted supply holders.
--
-- Wallets whose token holdings are EXCLUDED from the supply-concentration
-- screening gate (top-10 / top-20 %). Some good tokens legitimately have a
-- large share held by protocol / market-maker / treasury wallets; that stake
-- should not disqualify an otherwise well-distributed token at /submit. A
-- scammer's concentration still trips the gate normally.
--
-- Addresses live ONLY in this (private) prod table, never in the public repo.
-- Read by src/services/token-screener.js -> checkHolderConcentration.
-- Operator-mandated 2026-07-04.
CREATE TABLE IF NOT EXISTS screening_trusted_holders (
  wallet_address TEXT PRIMARY KEY,
  note           TEXT,
  added_by       TEXT,
  added_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
