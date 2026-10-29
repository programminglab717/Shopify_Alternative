-- 0400 · Combined listings in Urdu
-- A combined listing's option and values in Urdu (CAT-23), which the storefront's Urdu pages show
-- in place of the shop's own words. See ADR-902 in docs/architecture/13-decision-log.md.

ALTER TABLE catalog.combined_listings
  ADD COLUMN option_name_ur text CHECK (length(option_name_ur) BETWEEN 1 AND 255);

ALTER TABLE catalog.combined_listing_products
  ADD COLUMN value_ur text CHECK (length(value_ur) BETWEEN 1 AND 255);
