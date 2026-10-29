-- 0425 · An expansion store's margin for a single product (CH-11)
-- A product's copied price may be put a percent of its own over the store's rate, whatever its
-- collections' margins (ADR-948) or the store's: the costly sofa dearer to ship than the rest of
-- its collection. Twenty-five at most. See ADR-960 in docs/architecture/13-decision-log.md.

ALTER TABLE catalog.expansion_stores
  ADD COLUMN product_margins jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(product_margins) = 'array' AND jsonb_array_length(product_margins) <= 25);
