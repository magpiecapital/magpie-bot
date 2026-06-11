-- Pin AAPLx in canonical_rwa_mints.
--
-- AAPLx (Apple — Backed xStock) is a tokenized US equity issued by Backed
-- Finance, the same issuer behind every other xStock Magpie already pins
-- (SPYx, TSLAx, NVDAx, etc.). It uses the identical authority set:
--   mint authority      = 7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj
--   freeze authority    = JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs
--   permanent delegate  = 5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq
-- All three match the existing RWA env vars on Railway, so no screener
-- env changes are required.
--
-- The canonical pin protects against the symbol-spoofing attack from
-- migration 020: an attacker inserting `supported_mints.symbol='AAPLx'`
-- with a different mint would now fail the
-- `trg_supported_mints_rwa_canonical` trigger.
--
-- Verified on-chain 2026-06-11:
--   Token-2022 ✓
--   supply 15,376,550,662,207 (15.38M units at 8 decimals)
--   mint authority matches Backed ✓
--   freeze authority matches Backed ✓
--   permanent delegate matches Backed ✓
--   8 extensions present (ScaledUiAmount, etc.)

INSERT INTO canonical_rwa_mints (symbol, mint, issuer, notes) VALUES
  ('AAPLx', 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', 'backed_finance',
   'Apple — Backed xStock. Pinned 2026-06-11 post-RWA-research. Same authority set as other Backed xStocks.')
ON CONFLICT (symbol) DO NOTHING;
