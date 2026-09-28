-- 0012 · Order risk
-- How likely a cash-on-delivery order is to come back unpaid, from transparent rules: the
-- customer's history in this shop, the order's value and size, and its address. Orders at or above
-- the shop's threshold wait for review. See docs/architecture/05-checkout-and-payments.md §5 and
-- docs/engineering/conventions.md.

-- Assessed when a cash-on-delivery order is placed and when its address changes. Prepaid orders,
-- and orders placed before this migration, have none.
ALTER TABLE orders.orders
  ADD COLUMN risk_score   smallint CHECK (risk_score BETWEEN 0 AND 100),
  ADD COLUMN risk_level   text     CHECK (risk_level IN ('low', 'medium', 'high')),
  -- [{ "code": "refused_deliveries", "message": "…", "weight": 50 }], strongest first.
  ADD COLUMN risk_reasons jsonb    NOT NULL DEFAULT '[]',
  ADD CONSTRAINT orders_risk_check CHECK ((risk_score IS NULL) = (risk_level IS NULL));

-- The order list filters by risk level, like it does by stage.
CREATE INDEX orders_risk_idx ON orders.orders (shop_id, risk_level, id DESC);

-- The shop's policy. A shop without a row has the defaults in risk.ts.
CREATE TABLE orders.risk_settings (
  shop_id    uuid        PRIMARY KEY,
  -- Cash-on-delivery orders scoring this or more wait for review; null holds none.
  hold_at    smallint    CHECK (hold_at BETWEEN 1 AND 100),
  -- Orders totalling this or more count as high value; minor units of the shop's currency.
  high_value bigint      NOT NULL CHECK (high_value > 0),
  version    integer     NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('orders.risk_settings');
