-- 0074 · When an order's customer agreed to the shop's policies
-- Orders placed through checkout or a draft's link agreed as they were placed; an order staff or
-- an app placed agrees when its customer confirms it through its link, after it was placed
-- (ADR-115). Those that agreed before this did so when they were placed.
ALTER TABLE orders.orders ADD COLUMN agreed_at timestamptz;

UPDATE orders.orders SET agreed_at = created_at WHERE agreed_policy_versions IS NOT NULL;

ALTER TABLE orders.orders
  ADD CONSTRAINT orders_agreed_at_check
  CHECK ((agreed_policy_versions IS NULL) = (agreed_at IS NULL));
