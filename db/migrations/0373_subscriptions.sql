-- 0373 · Subscriptions (CAT-16)
-- A shop's selling plans: "Every month, 10% off", for its products of a tag, or all of them. A
-- shopper subscribes on a product's page; the order they place then keeps the plan on its line,
-- at the plan's price, and becomes a subscription: the same items, to the same address, ordered
-- again each interval at the plan's price as the items then cost, by cash on delivery (or bank
-- transfer, where the first was so paid), each order confirmed as any other is. The customer
-- skips, pauses or cancels it from their order's page; staff from the admin. No card or wallet is
-- charged: Hatti keeps none. See ADR-862 in docs/architecture/13-decision-log.md.

CREATE TABLE catalog.selling_plans (
  shop_id          uuid        NOT NULL,
  id               uuid        NOT NULL DEFAULT platform.uuidv7(),
  name             text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  interval_unit    text        NOT NULL CHECK (interval_unit IN ('week', 'month')),
  interval_count   integer     NOT NULL CHECK (interval_count BETWEEN 1 AND 12),
  -- What its orders take off the items' prices, a whole percent.
  discount_percent integer     NOT NULL CHECK (discount_percent BETWEEN 0 AND 50),
  -- The tag of the products it is for, as staff tag them; null for all of them.
  product_tag      text        CHECK (char_length(product_tag) BETWEEN 1 AND 255),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('catalog.selling_plans');

CREATE TABLE orders.subscriptions (
  shop_id          uuid        NOT NULL,
  id               uuid        NOT NULL DEFAULT platform.uuidv7(),
  customer_id      uuid        NOT NULL,
  -- The order the shopper subscribed with.
  origin_order_id  uuid        NOT NULL,
  -- The plan as it was then: it may change or go since.
  plan_id          uuid        NOT NULL,
  plan_name        text        NOT NULL,
  interval_unit    text        NOT NULL CHECK (interval_unit IN ('week', 'month')),
  interval_count   integer     NOT NULL CHECK (interval_count BETWEEN 1 AND 12),
  discount_percent integer     NOT NULL CHECK (discount_percent BETWEEN 0 AND 50),
  -- [{variantId, quantity, properties}]: what each order holds.
  lines            jsonb       NOT NULL,
  shipping_address jsonb       NOT NULL,
  email            text,
  payment_method   text        NOT NULL CHECK (payment_method IN ('cash_on_delivery',
                                                                  'bank_transfer')),
  -- Where the first order came from, as each of its orders says.
  source           text        NOT NULL,
  -- What each order charges for delivery and for paying on it, as the first did.
  shipping         bigint      NOT NULL CHECK (shipping >= 0),
  cod_fee          bigint      NOT NULL DEFAULT 0 CHECK (cod_fee >= 0),
  status           text        NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'paused', 'cancelled')),
  -- The day its next order is placed, in Pakistan's time.
  next_order_on    date        NOT NULL,
  orders_placed    integer     NOT NULL DEFAULT 1,
  last_order_id    uuid,
  -- Why the last order it was due could not be placed, and on how many days in a row: after
  -- three, that order is skipped. Null and none once one is placed.
  last_error       text,
  failed_tries     integer     NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  cancelled_at     timestamptz,
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, origin_order_id, plan_id)
);

SELECT platform.enable_tenant_isolation('orders.subscriptions');

CREATE INDEX subscriptions_due ON orders.subscriptions (next_order_on) WHERE status = 'active';
CREATE INDEX subscriptions_of_customer ON orders.subscriptions (shop_id, customer_id);
