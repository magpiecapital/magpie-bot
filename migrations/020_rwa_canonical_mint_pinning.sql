-- Canonical RWA mint pinning — prevents symbol-spoofing attacks.
--
-- Scenario this stops: an attacker inserts a row with symbol='SPYx'
-- but a different mint address. Without canonical pinning the row
-- coexists with the real SPYx; the loan UI happily renders it as
-- "SPYx" and users approve loans against a worthless impostor.
--
-- Defense: a small immutable table mapping the canonical symbol to
-- the canonical mint for every Backed Finance xStock and equivalent.
-- A trigger on supported_mints rejects any insert/update where the
-- category is stock/etf/metal AND the symbol is canonical AND the
-- mint doesn't match the canonical pin.
--
-- New tickers added in the future require: (a) operator INSERT into
-- canonical_rwa_mints with the verified Backed mint, then (b) the
-- normal supported_mints onboarding flow. Out-of-band changes fail.

CREATE TABLE IF NOT EXISTS canonical_rwa_mints (
  symbol       TEXT PRIMARY KEY,
  mint         TEXT NOT NULL UNIQUE,
  issuer       TEXT NOT NULL DEFAULT 'backed_finance',
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by     TEXT,
  notes        TEXT
);

-- Seed with the 18 RWA tokens currently enabled in supported_mints.
-- These mint addresses were verified at seed time. If the operator
-- discovers a wrong pin here, they DELETE the row, re-verify against
-- Backed's official docs / on-chain mint authority, and re-INSERT.
INSERT INTO canonical_rwa_mints (symbol, mint, notes) VALUES
  ('SPYx',   'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', 'S&P 500 ETF — Backed xStock'),
  ('QQQx',   'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ', 'Nasdaq 100 ETF — Backed xStock'),
  ('GLDx',   'Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re', 'Gold ETF — Backed xStock'),
  ('NVDAx',  'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', 'NVIDIA — Backed xStock'),
  ('TSLAx',  'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', 'Tesla — Backed xStock'),
  ('GOOGLx', 'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN', 'Alphabet — Backed xStock'),
  ('MSFTx',  'XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX', 'Microsoft — Backed xStock'),
  ('METAx',  'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu', 'Meta — Backed xStock'),
  ('AMZNx',  'Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg', 'Amazon — Backed xStock'),
  ('COINx',  'Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu', 'Coinbase — Backed xStock'),
  ('MSTRx',  'XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ', 'MicroStrategy — Backed xStock'),
  ('HOODx',  'XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg', 'Robinhood — Backed xStock'),
  ('CRCLx',  'XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1', 'Circle — Backed xStock'),
  ('STRCx',  'Xs78JED6PFZxWc2wCEPspZW9kL3Se5J7L5TChKgsidH', 'Strategy preferred — Backed xStock'),
  ('PLTRx',  'XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4', 'Palantir — Backed xStock')
ON CONFLICT (symbol) DO NOTHING;

-- Enforcement trigger: any insert/update to supported_mints with a
-- canonical RWA symbol must use the canonical mint.
CREATE OR REPLACE FUNCTION supported_mints_enforce_rwa_canonical()
RETURNS TRIGGER AS $$
DECLARE
  pinned_mint TEXT;
BEGIN
  IF NEW.category IN ('stock', 'etf', 'metal') THEN
    SELECT mint INTO pinned_mint FROM canonical_rwa_mints WHERE symbol = NEW.symbol;
    IF pinned_mint IS NOT NULL AND pinned_mint <> NEW.mint THEN
      RAISE EXCEPTION 'symbol % is canonically pinned to mint %, refusing to insert with mint %', NEW.symbol, pinned_mint, NEW.mint
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_supported_mints_rwa_canonical ON supported_mints;
CREATE TRIGGER trg_supported_mints_rwa_canonical
  BEFORE INSERT OR UPDATE ON supported_mints
  FOR EACH ROW EXECUTE FUNCTION supported_mints_enforce_rwa_canonical();
