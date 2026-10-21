-- 0308 · Delivery charged more for heavier orders
-- A shop says what orders weighing more than some weights cost more to deliver, as couriers
-- charge by weight: checkout adds the charge of the heaviest weight the cart passes, to the
-- city's charge (CHK-04). See ADR-702 in docs/architecture/13-decision-log.md.

ALTER TABLE checkout.delivery_settings ADD COLUMN weights jsonb NOT NULL DEFAULT '[]';
