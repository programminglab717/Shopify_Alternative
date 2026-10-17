-- 0244 · Discounts for some products or collections
-- A percentage or an amount off only the items of the products and collections a code or an
-- automatic discount names, as Shopify's "applies to specific products or collections" is
-- (CHK-06, V1). Neither named, it is for the whole order, as before. Its minimum is what those
-- items come to; an amount off is once an order, no more than they come to. Free delivery is for
-- the whole order. The IDs are the catalog's; one deleted no longer matches anything. See ADR-517
-- in docs/architecture/13-decision-log.md.

ALTER TABLE pricing.discount_codes
  ADD COLUMN product_ids    uuid[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(product_ids) <= 100),
  ADD COLUMN collection_ids uuid[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(collection_ids) <= 100),
  ADD CONSTRAINT discount_codes_items_check
    CHECK (kind <> 'free_shipping' OR (product_ids = '{}' AND collection_ids = '{}'));

ALTER TABLE pricing.automatic_discounts
  ADD COLUMN product_ids    uuid[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(product_ids) <= 100),
  ADD COLUMN collection_ids uuid[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(collection_ids) <= 100),
  ADD CONSTRAINT automatic_discounts_items_check
    CHECK (kind <> 'free_shipping' OR (product_ids = '{}' AND collection_ids = '{}'));
