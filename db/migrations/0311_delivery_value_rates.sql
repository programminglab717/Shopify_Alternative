-- 0311 · Delivery rates by the order's value
-- A shop says what larger orders pay at most to deliver, such as Rs 150 from Rs 3,000: checkout
-- charges the city's charge, or the rate of the largest value the order reaches where that is
-- less, before what its weight adds (CHK-04). See ADR-721 in docs/architecture/13-decision-log.md.

ALTER TABLE checkout.delivery_settings ADD COLUMN value_rates jsonb NOT NULL DEFAULT '[]';
