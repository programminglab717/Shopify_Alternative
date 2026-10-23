-- 0330 · How many orders a delivery slot takes
-- A shop that delivers itself can take only so many orders in a time of the day: a bakery's oven,
-- a florist's one rider. Checkout no longer offers a slot that has as many orders as the shop
-- takes in it, cancelled ones aside (CHK-15). See ADR-772 in docs/architecture/13-decision-log.md.

ALTER TABLE checkout.delivery_settings
  ADD COLUMN slot_capacity smallint CHECK (slot_capacity BETWEEN 1 AND 1000);

-- The orders in a shop's slots, counted while checkout offers them.
CREATE INDEX orders_delivery_slot_idx ON orders.orders (shop_id, delivery_slot_starts_at)
  WHERE delivery_slot_starts_at IS NOT NULL AND cancelled_at IS NULL;
