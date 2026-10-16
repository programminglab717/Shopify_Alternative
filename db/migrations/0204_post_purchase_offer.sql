-- 0204 · Post-purchase offer
-- A cash-on-delivery order's page offers its customer one of the products the shop pairs with
-- what they bought, at the shop's percentage off, added with a tap and paid at the door, until it
-- is packed (MKT-09, 05 §8). Null is no offer; 0 offers it at its price.
-- See ADR-438 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.order_settings
  ADD COLUMN upsell_percent_off smallint CHECK (upsell_percent_off BETWEEN 0 AND 50);

-- When its customer took the offer: an order takes it once.
ALTER TABLE orders.orders ADD COLUMN upsold_at timestamptz;
