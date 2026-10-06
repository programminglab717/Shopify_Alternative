-- 0145 · How long delivery takes
-- A shop may say how many working days delivery takes, for everywhere and for each of its
-- delivery zones (CHK-22): its storefront's cart and product pages show how long delivery takes,
-- and checkout shows it for the shopper's city. A zone's own is kept in its JSON, beside its
-- charge; a zone without one takes everywhere's. See ADR-235 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE checkout.delivery_settings
  ADD COLUMN min_days smallint,
  ADD COLUMN max_days smallint,
  ADD CONSTRAINT delivery_settings_days_check
    CHECK ((min_days IS NULL) = (max_days IS NULL)
           AND min_days BETWEEN 0 AND 30
           AND max_days BETWEEN min_days AND 30);
