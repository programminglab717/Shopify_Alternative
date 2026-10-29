-- 0417 · An expansion store's margin and rounding (CH-11)
-- Its copied prices may be a percent over its rate, the day's or one given by hand, for what
-- selling abroad costs the shop, and rounded as its prices abroad are: to the cent, a whole unit,
-- or up to the next .99. Costs are copied exact. Changing either has the link copied again as its
-- rate changing does. See ADR-933 in docs/architecture/13-decision-log.md.

ALTER TABLE catalog.expansion_stores
  ADD COLUMN margin_percent smallint NOT NULL DEFAULT 0 CHECK (margin_percent BETWEEN 0 AND 100),
  ADD COLUMN rounding text NOT NULL DEFAULT 'exact'
    CHECK (rounding IN ('exact', 'whole', 'ninety_nine'));
