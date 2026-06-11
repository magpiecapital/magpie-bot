-- Premium-tier whitelist + Friday-close cutoff infrastructure.
--
-- The premium_tier_whitelist table gates which tokenized stocks can be
-- used as collateral on the v3-premium pool. The screener at
-- src/services/premium-tier-screener.js was already referencing this
-- table but it didn't exist — every premium borrow would fail with
-- "relation not found" once the screener wired up. This migration
-- creates the table and seeds it with the operator-approved top names.
--
-- Per-mint max_open_lamports is the AGGREGATE exposure cap: when the
-- sum of currently-active premium loans against this mint exceeds
-- max_open_lamports, new borrows refuse until existing loans repay.
-- Conservative defaults below; operator can raise as the tier matures
-- and liquidation data accumulates.

CREATE TABLE IF NOT EXISTS premium_tier_whitelist (
  mint                text        PRIMARY KEY,
  symbol              text        NOT NULL,
  max_open_lamports   numeric     NOT NULL,
  enabled             boolean     NOT NULL DEFAULT TRUE,
  added_at            timestamptz NOT NULL DEFAULT now(),
  added_by            text,
  notes               text
);

-- Seed the operator's recommended top-12 (minus AAPLx which isn't yet
-- in supported_mints — operator to confirm mint address + add via
-- /onboard-rwa-collateral.js).
--
-- Initial caps: 50 SOL per mint for the top names, 25 SOL for the rest.
-- These are AGGREGATE exposure caps (sum of all active loans against
-- the mint), not per-loan. The per-loan cap stays at PREMIUM_TIER_MAX_LOAN_LAMPORTS
-- (10 SOL by default).

INSERT INTO premium_tier_whitelist (mint, symbol, max_open_lamports, notes)
VALUES
  -- ETFs / index — deepest weekend liquidity per xStocks roundup
  ('XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', 'SPYx',  50000000000, 'S&P 500 — deepest weekend liquidity on Kraken Pro'),
  ('Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ', 'QQQx',  50000000000, 'Nasdaq 100 — deep weekend liquidity'),
  ('Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re', 'GLDx',  50000000000, 'Gold ETF — non-equity, weekend-resilient'),
  -- Mega-cap tech
  ('Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', 'NVDAx', 50000000000, 'NVIDIA — top-3 active wallet count'),
  ('XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', 'TSLAx', 50000000000, 'Tesla — top weekend liquidity tier'),
  ('XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN', 'GOOGLx', 25000000000, 'Alphabet — deep weekend liquidity'),
  ('XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX', 'MSFTx', 25000000000, 'Microsoft — deep weekend liquidity'),
  ('Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu', 'METAx', 25000000000, 'Meta — deep weekend liquidity'),
  ('Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg', 'AMZNx', 25000000000, 'Amazon — deep weekend liquidity'),
  -- Crypto-adjacent equities
  ('Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu', 'COINx', 25000000000, 'Coinbase — crypto-adjacent, demand expected'),
  ('XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ', 'MSTRx', 25000000000, 'MicroStrategy — crypto-adjacent, deep weekend liquidity'),
  ('XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg', 'HOODx', 25000000000, 'Robinhood — deep weekend liquidity'),
  ('XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1', 'CRCLx', 25000000000, 'Circle — crypto-adjacent, top active wallets')
ON CONFLICT (mint) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_premium_tier_whitelist_enabled
  ON premium_tier_whitelist(enabled, symbol);

-- ─── Security cleanup: reclassify mis-categorized memecoins ────────
-- The supported_mints table has tokens classified as category='stock'
-- that are actually pump.fun memecoins (mint ends in 'pump' suffix).
-- Without this fix they would pass the category gate at
-- premium-tier-screener.js:58. This isn't exploitable on its own (every
-- subsequent gate would still refuse since they're not in
-- premium_tier_whitelist) but it's defense-in-depth: don't let the
-- category lie.

UPDATE supported_mints
   SET category = 'memecoin', enabled = FALSE
 WHERE category = 'stock'
   AND mint LIKE '%pump';
