-- 0329 · An order's delivery slot
-- An order placed through checkout keeps the time the shopper chose to have it delivered in, of
-- those the shop offers (CHK-15): when it starts and ends. See ADR-769 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE orders.orders
  ADD COLUMN delivery_slot_starts_at timestamptz,
  ADD COLUMN delivery_slot_ends_at timestamptz,
  ADD CONSTRAINT orders_delivery_slot_check CHECK (
    (delivery_slot_starts_at IS NULL) = (delivery_slot_ends_at IS NULL)
    AND (delivery_slot_starts_at IS NULL OR delivery_slot_ends_at > delivery_slot_starts_at)
  );
