-- 0141 · An advance for products the shop tags
-- Cash on delivery's advance may be asked only of orders holding a product with a tag the shop
-- names, as pre-orders and custom stitching are paid in part ahead (CHK-10), as well as above a
-- total, to cities it names, of the customers it says and by risk. Checkout knows the cart's
-- products before the shopper types, so its page names the product. See ADR-224 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE checkout.cod_settings
  -- Products' tags, in any letter case; empty for every order.
  ADD COLUMN advance_product_tags text[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(advance_product_tags) <= 50),
  DROP CONSTRAINT cod_settings_advance_rule_check,
  ADD CONSTRAINT cod_settings_advance_rule_check CHECK (
    (advance_kind IS NOT DISTINCT FROM 'fixed_amount') = (advance_amount IS NOT NULL)
    AND (advance_kind IS NOT DISTINCT FROM 'percentage') = (advance_bps IS NOT NULL)
    AND (advance_kind IS NOT NULL
         OR (advance_above IS NULL AND advance_cities = '{}' AND advance_refused IS NULL
             AND NOT advance_new_customers AND advance_risk IS NULL
             AND advance_product_tags = '{}')));
