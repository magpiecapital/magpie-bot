-- 097 · Per-token borrow reservations (per-token cap TOCTOU fix)
--
-- The per-token exposure cap (anti-exploit preBorrowAntiExploitCheck) read
-- SUM(active loans) with no lock, and the loan is only recorded AFTER the tx
-- broadcasts — so N concurrent borrows against the same mint could all read the
-- same pre-borrow sum, all pass, and total exposure could land at N× the cap.
--
-- This table holds SHORT-LIVED, in-flight borrow reservations. The cap check
-- now runs under a per-mint advisory lock and counts (active loans + unexpired
-- reservations), inserting a reservation atomically when a borrow passes. A
-- short TTL makes it self-cleaning and conservative: a reservation persists
-- across the borrow's broadcast+record window, then expires (a brief, safe
-- double-count with the now-active loan is fine; it only ever UNDER-exposes).

CREATE TABLE IF NOT EXISTS borrow_reservations (
  id              BIGSERIAL   PRIMARY KEY,
  collateral_mint TEXT        NOT NULL,
  amount_lamports BIGINT      NOT NULL,
  wallet          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);

-- Hot path filters by (mint, expires_at). Keep it tight.
CREATE INDEX IF NOT EXISTS idx_borrow_reservations_mint_exp
  ON borrow_reservations (collateral_mint, expires_at);
