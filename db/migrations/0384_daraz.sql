-- 0384 · Daraz sync (CH-06)
-- A shop's Daraz Seller Center account, connected through Daraz's Open Platform: its seller's
-- tokens, sealed with the shop's keys; the location whose stock it sells; Daraz's orders brought in
-- as the shop's orders, each once; and the stock and prices last given to Daraz for each SKU, so
-- that only what changed is sent. See ADR-875 in docs/architecture/13-decision-log.md.

CREATE TABLE orders.daraz_accounts (
  shop_id            uuid        PRIMARY KEY,
  account            text        NOT NULL CHECK (length(account) BETWEEN 1 AND 200),
  seller_id          text        CHECK (length(seller_id) <= 64),
  access_token       text        NOT NULL,
  refresh_token      text        NOT NULL,
  access_expires_at  timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  -- Where its stock comes from and its orders ship from. No foreign key: the inventory module's.
  location_id        uuid        NOT NULL,
  -- Whether Daraz's prices follow the shop's; its stock always does.
  sync_prices        boolean     NOT NULL DEFAULT false,
  -- Orders changed since this are read next.
  orders_read_to     timestamptz NOT NULL,
  synced_at          timestamptz,
  last_error         text        CHECK (length(last_error) <= 500),
  connected_at       timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('orders.daraz_accounts');

CREATE TABLE orders.daraz_orders (
  shop_id        uuid        NOT NULL,
  daraz_order_id text        NOT NULL CHECK (length(daraz_order_id) BETWEEN 1 AND 64),
  -- The shop's order it became; none for one left out.
  order_id       uuid,
  status         text        NOT NULL CHECK (length(status) BETWEEN 1 AND 40),
  -- Why it was left out: SKUs the shop doesn't sell, or an address it could not take.
  error          text        CHECK (length(error) <= 500),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, daraz_order_id)
);

SELECT platform.enable_tenant_isolation('orders.daraz_orders');

CREATE TABLE orders.daraz_listings (
  shop_id    uuid        NOT NULL,
  sku        text        NOT NULL CHECK (length(sku) BETWEEN 1 AND 200),
  quantity   integer     NOT NULL,
  price      bigint,
  -- Why Daraz refused it last, as a SKU it has no listing of.
  error      text        CHECK (length(error) <= 500),
  pushed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, sku)
);

SELECT platform.enable_tenant_isolation('orders.daraz_listings');
