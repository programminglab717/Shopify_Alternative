-- 0245 · Buy X get Y
-- A code or an automatic discount that gives some items of an order at a percentage off, free
-- unless it says less, for every so many bought, as Shopify's "Buy X get Y" does (CHK-06, V1):
-- "buy 2, get 1 free". The items counted and those given are of the products and collections it
-- names, or any; in each group of buy_quantity + get_quantity, the cheapest get_quantity are
-- given. percentage_bps is how much off those, 10000 for free. See ADR-519 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE pricing.discount_codes
  DROP CONSTRAINT discount_codes_kind_check,
  ADD CONSTRAINT discount_codes_kind_check
    CHECK (kind IN ('percentage', 'fixed_amount', 'free_shipping', 'buy_x_get_y')),
  DROP CONSTRAINT discount_codes_value_check,
  ADD COLUMN buy_quantity integer CHECK (buy_quantity BETWEEN 1 AND 100),
  ADD COLUMN get_quantity integer CHECK (get_quantity BETWEEN 1 AND 100),
  ADD CONSTRAINT discount_codes_value_check CHECK (
    (kind IN ('percentage', 'buy_x_get_y')) = (percentage_bps IS NOT NULL)
    AND (kind = 'fixed_amount') = (amount IS NOT NULL)
    AND (kind = 'buy_x_get_y') = (buy_quantity IS NOT NULL AND get_quantity IS NOT NULL)
  );

ALTER TABLE pricing.automatic_discounts
  DROP CONSTRAINT automatic_discounts_kind_check,
  ADD CONSTRAINT automatic_discounts_kind_check
    CHECK (kind IN ('percentage', 'fixed_amount', 'free_shipping', 'buy_x_get_y')),
  DROP CONSTRAINT automatic_discounts_value_check,
  ADD COLUMN buy_quantity integer CHECK (buy_quantity BETWEEN 1 AND 100),
  ADD COLUMN get_quantity integer CHECK (get_quantity BETWEEN 1 AND 100),
  ADD CONSTRAINT automatic_discounts_value_check CHECK (
    (kind IN ('percentage', 'buy_x_get_y')) = (percentage_bps IS NOT NULL)
    AND (kind = 'fixed_amount') = (amount IS NOT NULL)
    AND (kind = 'buy_x_get_y') = (buy_quantity IS NOT NULL AND get_quantity IS NOT NULL)
  );
