-- 0413 · A selling plan's minimum number of orders (CAT-16)
-- A shop may ask a subscriber to take at least so many orders of a plan, its discount being for
-- that commitment: until then the customer may skip or pause from their order's page, but not
-- cancel. Staff cancel whenever they must. The subscription keeps the minimum its plan had, as it
-- keeps the plan's other terms. See ADR-928 in docs/architecture/13-decision-log.md.

ALTER TABLE catalog.selling_plans
  ADD COLUMN minimum_orders smallint NOT NULL DEFAULT 0 CHECK (minimum_orders BETWEEN 0 AND 12);

ALTER TABLE orders.subscriptions
  ADD COLUMN minimum_orders smallint NOT NULL DEFAULT 0 CHECK (minimum_orders BETWEEN 0 AND 12);
