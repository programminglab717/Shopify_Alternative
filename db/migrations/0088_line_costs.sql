-- 0088 · What lines cost the shop
-- Each order line keeps what one unit of its variant cost the shop when it was sold (ANL-03,
-- ADR-141), as Shopify records costs at the time of sale: the sales report works out the cost of
-- goods and profit from it, whatever the variant costs later. Null when the variant had no cost;
-- lines sold before it are left without one.

ALTER TABLE orders.lines
  ADD COLUMN unit_cost bigint CHECK (unit_cost >= 0);
