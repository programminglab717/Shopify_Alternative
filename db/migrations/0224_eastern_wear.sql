-- 0224 · Eastern-wear attributes
-- How Pakistani shoppers choose a suit (CAT-08): whether it comes stitched, in how many pieces,
-- of what fabrics and for which season, from Hatti's own words for each, so every shop's lawn is
-- the same lawn to filter by. Null where none is said. See ADR-477 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE catalog.products
  ADD COLUMN eastern_wear jsonb CHECK (jsonb_typeof(eastern_wear) = 'object');
