-- migration 062: supported_mints.is_canonical + ticker-collision safety.
--
-- WHY THIS EXISTS
-- ───────────────
-- 2026-06-14: operator-flagged class of vulnerability. The
-- supported_mints table can contain two ENABLED rows with the same
-- symbol but DIFFERENT categories — e.g. a legitimate memecoin and a
-- tokenized stock that happen to share a ticker (SPCX/SpaceX,
-- TSLA/Tesla, etc.). Operator wants to allow this when both have
-- independently passed token screening — memecoins with collided
-- tickers ARE legitimate when they're real assets, just risky.
--
-- The SYSTEM must distinguish the two safely without depending on
-- the user spotting the collision. The defenses below handle this
-- by ensuring:
--   1. The mint pubkey is always the authoritative routing key (the
--      borrow path already does this — confirmed via audit).
--   2. Symbol-keyed code paths (Pip's tools, /risk, etc.) refuse to
--      silently pick when a ticker has multiple enabled matches.
--   3. Operator gets a NOTICE log line every time a collision is
--      introduced so they can verify it was intentional.
--
-- WHAT THIS MIGRATION DOES
-- ────────────────────────
-- 1. Adds is_canonical BOOLEAN. Marks the operator-vetted "this is
--    the asset the ticker most naturally refers to" row when ties
--    exist. Used by symbol-keyed lookups as a tiebreaker (see
--    services/safe-symbol-lookup.js).
-- 2. Installs a BEFORE INSERT/UPDATE trigger that does NOT block
--    cross-category collisions but RAISES NOTICE (so operator sees
--    it in logs / DM via the wired-up notice listener) whenever an
--    enable creates a new cross-category collision. Fail-OPEN: never
--    rejects a legitimate dual-listing.
-- 3. Backfills is_canonical = TRUE for any symbol that currently has
--    exactly ONE enabled mint — unambiguous canonical.
-- 4. For the existing SPCX collision: marks the tokenized stock SPCX
--    canonical so symbol-keyed lookups resolve to it by default.
--    Leaves the memecoin SPCX enabled — operator's call whether to
--    keep it given it currently doesn't mark itself as a memecoin
--    in its name field ("SpaceX" instead of e.g. "SpaceX Coin").
--
-- DOWNGRADE
-- ─────────
-- Drop the trigger first, then the function, then the column.

ALTER TABLE supported_mints
  ADD COLUMN IF NOT EXISTS is_canonical BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN supported_mints.is_canonical IS
  'When TRUE, this is the operator-vetted authoritative row for its
   ticker. Symbol-keyed lookups prefer is_canonical=TRUE when multiple
   enabled rows share a symbol. At most ONE canonical row per (symbol,
   category) pair is allowed when enabled (partial unique index below).
   Operator sets this via /set-canonical <mint> after vetting.';

CREATE UNIQUE INDEX IF NOT EXISTS supported_mints_canonical_per_symbol_category
  ON supported_mints(symbol, category)
  WHERE is_canonical = TRUE AND enabled = TRUE;

-- ── Cross-category collision NOTICE trigger ───────────────────────────
-- Does NOT block. RAISES NOTICE so operator and code-side log
-- collectors see when a cross-category collision is created. This is
-- the operator's "the system recognizes this" requirement — every
-- collision gets surfaced for review without breaking legitimate
-- dual-listings (memecoin + RWA with the same ticker, when both
-- pass screening).

CREATE OR REPLACE FUNCTION notice_cross_category_symbol_collision()
RETURNS TRIGGER AS $func$
DECLARE
  conflicting_count INTEGER;
  conflicting_mints TEXT;
BEGIN
  IF NEW.enabled = TRUE THEN
    -- Look for enabled rows with the same symbol but a DIFFERENT
    -- category-class (RWA-class = stock/etf/metal; memecoin = its
    -- own class).
    IF NEW.category IN ('stock', 'etf', 'metal') THEN
      SELECT COUNT(*)::int, STRING_AGG(mint, ', ')
        INTO conflicting_count, conflicting_mints
        FROM supported_mints
       WHERE UPPER(symbol) = UPPER(NEW.symbol)
         AND enabled = TRUE
         AND category = 'memecoin'
         AND mint != NEW.mint;
    ELSIF NEW.category = 'memecoin' THEN
      SELECT COUNT(*)::int, STRING_AGG(mint, ', ')
        INTO conflicting_count, conflicting_mints
        FROM supported_mints
       WHERE UPPER(symbol) = UPPER(NEW.symbol)
         AND enabled = TRUE
         AND category IN ('stock', 'etf', 'metal')
         AND mint != NEW.mint;
    ELSE
      conflicting_count := 0;
    END IF;

    IF conflicting_count > 0 THEN
      RAISE NOTICE 'CROSS_CATEGORY_TICKER_COLLISION: enabling % "%" (mint %) but % enabled row(s) with the same ticker in the OPPOSITE category-class already exist: %. The mint pubkey remains the authoritative routing key; symbol-keyed lookups will refuse to disambiguate without is_canonical. Operator: verify this dual-listing is intentional + set is_canonical on the right row via /set-canonical.',
        NEW.category, NEW.symbol, NEW.mint, conflicting_count, conflicting_mints;
    END IF;
  END IF;
  RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_supported_mints_collision_notice ON supported_mints;
CREATE TRIGGER tg_supported_mints_collision_notice
  BEFORE INSERT OR UPDATE OF symbol, category, enabled, mint
  ON supported_mints
  FOR EACH ROW
  EXECUTE FUNCTION notice_cross_category_symbol_collision();

-- ── Backfill ──────────────────────────────────────────────────────────

-- Any symbol with exactly one enabled mint today: that mint is
-- canonical by default. Operator can flip via /set-canonical later.
UPDATE supported_mints SET is_canonical = TRUE
WHERE enabled = TRUE
  AND is_canonical = FALSE
  AND symbol IN (
    SELECT symbol
      FROM supported_mints
     WHERE enabled = TRUE
     GROUP BY symbol
    HAVING COUNT(*) = 1
  );

-- For the known SPCX collision: mark the tokenized stock SPCX as
-- canonical. Symbol-keyed lookups will resolve to the stock by
-- default; explicit-mint lookups continue to route to whichever
-- mint the caller specifies (this is the safe path users hit via
-- their dashboard, which is mint-keyed).
UPDATE supported_mints
   SET is_canonical = TRUE
 WHERE mint = 'SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb';
