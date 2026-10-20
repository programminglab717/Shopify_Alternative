-- 0277 · The day an order's delivery was promised by (CHK-05)
-- Checkout says the day to expect delivery by, the shop's working days for the city counted past
-- Sundays and Pakistan's public holidays; the order keeps it, for its page. See ADR-595 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE orders.orders ADD COLUMN delivery_expected_on date;
