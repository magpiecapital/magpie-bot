-- Add tokenized stock tokens (xStocks from tokens.xyz) as approved collateral.
-- High-liquidity equities only. All use 9 decimals on Solana.

INSERT INTO supported_mints (mint, symbol, name, decimals) VALUES
  ('XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', 'xTSLA', 'Tesla', 9),
  ('Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', 'xNVDA', 'NVIDIA', 9),
  ('XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', 'xAAPL', 'Apple', 9),
  ('XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN', 'xGOOGL', 'Alphabet', 9),
  ('Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg', 'xAMZN', 'Amazon', 9),
  ('FRmH6iRkMr33DLG6zVLR7EM4LojBFAuq6NtFzG6ondo', 'xMSFT', 'Microsoft', 9),
  ('fDxs5y12E7x7jBwCKBXGqt71uJmCWsAQ3Srkte6ondo', 'xMETA', 'Meta', 9),
  ('XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ', 'xMSTR', 'MicroStrategy', 9),
  ('Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu', 'xCOIN', 'Coinbase', 9)
ON CONFLICT (mint) DO UPDATE
  SET symbol = EXCLUDED.symbol,
      name = EXCLUDED.name,
      decimals = EXCLUDED.decimals,
      enabled = TRUE;
