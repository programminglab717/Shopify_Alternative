-- 0131 · A product on the link page with its variant chosen
-- Each of the products a shop's link page shows (CH-07) may name one of its variants: the page
-- shows its price and image, and "Buy now" goes straight to checkout with it. The variant chosen
-- of each of link_products, by its place, NULL where none is; none for pages saved before.
-- See ADR-206 in docs/architecture/13-decision-log.md.

ALTER TABLE online_store.preferences
  ADD COLUMN link_variants uuid[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT preferences_link_variants_check
    CHECK (cardinality(link_variants) <= cardinality(link_products));
