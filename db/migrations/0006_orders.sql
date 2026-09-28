-- 0006 · Orders
-- Orders and their lines, each order's timeline, and per-shop order numbers. An order commits its
-- stock through the inventory module in the same transaction that creates it.
-- See docs/architecture/03-multi-tenancy-and-data.md §6.1 and docs/engineering/conventions.md.

CREATE SCHEMA orders;

GRANT USAGE ON SCHEMA orders TO hatti_app_role, hatti_system_role;

-- ---------------------------------------------------------------------------------------------
-- Order numbers: #1001 onwards, per shop. An order takes its number last in its transaction, so
-- the counter row is locked only briefly and an order that fails leaves no gap.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE orders.counters (
  shop_id     uuid    PRIMARY KEY,
  next_number integer NOT NULL CHECK (next_number > 0)
);

SELECT platform.enable_tenant_isolation('orders.counters');

-- ---------------------------------------------------------------------------------------------
-- Orders. Four statuses move independently, as in Shopify plus a confirmation status for cash on
-- delivery; `stage` is the single state merchants see, derived from them and kept up to date by
-- every change so that lists can filter and count by it. Amounts are minor units in `currency`.
-- The shipping address is a snapshot: later edits to a customer never change an order.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE orders.orders (
  shop_id             uuid        NOT NULL,
  id                  uuid        NOT NULL,
  number              integer     NOT NULL CHECK (number > 0),
  source              text        NOT NULL
                      CHECK (source IN ('online_store', 'whatsapp', 'instagram', 'facebook', 'pos',
                                        'manual', 'api', 'marketplace', 'reseller')),
  status              text        NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'closed', 'cancelled')),
  confirmation_status text        NOT NULL
                      CHECK (confirmation_status IN ('not_required', 'pending', 'confirmed',
                                                     'rejected', 'no_response', 'needs_review')),
  financial_status    text        NOT NULL
                      CHECK (financial_status IN ('pending', 'authorized', 'paid', 'partially_paid',
                                                  'partially_refunded', 'refunded', 'voided')),
  fulfillment_status  text        NOT NULL DEFAULT 'unfulfilled'
                      CHECK (fulfillment_status IN ('unfulfilled', 'partially_fulfilled', 'fulfilled',
                                                    'returned', 'partially_returned')),
  stage               text        NOT NULL
                      CHECK (stage IN ('needs_confirmation', 'needs_review', 'to_fulfill',
                                       'partially_fulfilled', 'in_transit', 'returning', 'delivered',
                                       'returned', 'completed', 'cancelled')),
  payment_method      text        NOT NULL CHECK (payment_method IN ('cash_on_delivery', 'prepaid')),
  currency            text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal            bigint      NOT NULL CHECK (subtotal >= 0),
  discount            bigint      NOT NULL CHECK (discount >= 0),
  shipping            bigint      NOT NULL CHECK (shipping >= 0),
  total               bigint      NOT NULL,
  amount_paid         bigint      NOT NULL CHECK (amount_paid >= 0),
  -- What the courier collects at the door.
  cod_amount          bigint      NOT NULL CHECK (cod_amount >= 0),
  -- The customer's mobile number (E.164), for confirmation and delivery.
  phone               text        NOT NULL CHECK (phone ~ '^\+923[0-9]{9}$'),
  email               text        CHECK (length(email) BETWEEN 3 AND 254),
  shipping_address    jsonb       NOT NULL,
  -- Where its stock was committed and where it ships from. No foreign key: the location belongs
  -- to the inventory module.
  location_id         uuid        NOT NULL,
  note                text        NOT NULL DEFAULT '' CHECK (length(note) <= 5000),
  tags                text[]      NOT NULL DEFAULT '{}',
  -- Normalised by searchKey() in @hatti/pk: the customer's name, city and email.
  search_text         text        NOT NULL DEFAULT '',
  cancel_reason       text        CHECK (cancel_reason IN ('customer', 'no_response', 'fraud',
                                                           'inventory', 'other')),
  confirmed_at        timestamptz,
  cancelled_at        timestamptz,
  paid_at             timestamptz,
  closed_at           timestamptz,
  version             integer     NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT orders_number_key UNIQUE (shop_id, number),
  CONSTRAINT orders_total_check CHECK (discount <= subtotal AND total = subtotal - discount + shipping),
  CONSTRAINT orders_paid_check CHECK (amount_paid <= total AND cod_amount <= total),
  CONSTRAINT orders_cancelled_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

CREATE INDEX orders_stage_idx ON orders.orders (shop_id, stage, id DESC);
CREATE INDEX orders_phone_idx ON orders.orders (shop_id, phone, id DESC);

SELECT platform.enable_tenant_isolation('orders.orders');

-- ---------------------------------------------------------------------------------------------
-- Lines: what was sold, as it was then. The variant may be deleted later; the line keeps its
-- titles, SKU and price. No foreign key to the catalog, for the same reason.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE orders.lines (
  shop_id       uuid        NOT NULL,
  id            uuid        NOT NULL,
  order_id      uuid        NOT NULL,
  position      integer     NOT NULL CHECK (position >= 1),
  variant_id    uuid        NOT NULL,
  product_id    uuid        NOT NULL,
  title         text        NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  variant_title text        NOT NULL,
  sku           text,
  quantity      integer     NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
  unit_price    bigint      NOT NULL CHECK (unit_price >= 0),
  total         bigint      NOT NULL,
  weight_grams  integer     CHECK (weight_grams >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT lines_position_key UNIQUE (shop_id, order_id, position),
  CONSTRAINT lines_total_check CHECK (total = unit_price * quantity),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders.orders (shop_id, id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('orders.lines');

-- ---------------------------------------------------------------------------------------------
-- The timeline: what happened to an order, who did it, in words for staff. Append-only.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE orders.order_events (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL,
  order_id   uuid        NOT NULL,
  kind       text        NOT NULL CHECK (kind ~ '^[a-z_]{1,64}$'),
  message    text        NOT NULL CHECK (length(message) BETWEEN 1 AND 2000),
  actor_kind text        NOT NULL CHECK (actor_kind IN ('app', 'staff', 'system')),
  -- The access token or the staff member; null for the system.
  actor_id   uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders.orders (shop_id, id) ON DELETE CASCADE
);

CREATE INDEX order_events_order_idx ON orders.order_events (shop_id, order_id, id);

SELECT platform.enable_tenant_isolation('orders.order_events');
REVOKE UPDATE, DELETE ON orders.order_events FROM hatti_app_role;
