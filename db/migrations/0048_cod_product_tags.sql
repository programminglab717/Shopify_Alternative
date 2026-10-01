-- 0048 · Cash on delivery's rules for products
-- A shop keeps cash on delivery from products it tags (CHK-07), such as pre-orders and custom
-- stitching: checkout offers bank transfer alone for a cart that holds one, or says why it can't
-- take the order. Tags match in any letter case, as Shopify's do. See ADR-078 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE checkout.cod_settings
  ADD COLUMN unavailable_product_tags text[] NOT NULL DEFAULT '{}'
      CHECK (cardinality(unavailable_product_tags) <= 50);
