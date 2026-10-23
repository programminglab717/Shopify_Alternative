-- 0336 · Orders from the store a shop moved from
-- A shop moving from Shopify brings its orders as they were there (ONB-05, ADR-786): a history to
-- look back on, never orders of Hatti's. They take no stock, send no messages, book no parcels and
-- count in no report; they cannot be changed. Each names the customer its number is, where the shop
-- has one, so their page shows what they bought before; merged, the history follows them; erased,
-- it keeps the amounts, items and city, as orders do. Brought twice, an order is kept once.

CREATE TABLE orders.past_orders (
  shop_id            uuid        NOT NULL,
  id                 uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- Where it was placed: shopify; and its ID there, which keeps it once.
  source             text        NOT NULL CHECK (source IN ('shopify')),
  source_id          text        NOT NULL,
  -- Its name there, as #1001.
  name               text        NOT NULL,
  customer_id        uuid,
  -- E.164, where the number was a Pakistani mobile's; as given otherwise.
  phone              text,
  email              text,
  placed_at          timestamptz NOT NULL,
  cancelled_at       timestamptz,
  -- ISO 4217, as the store priced it; amounts in its minor units.
  currency           text        NOT NULL,
  subtotal           bigint      NOT NULL,
  shipping           bigint      NOT NULL,
  discounts          bigint      NOT NULL,
  total              bigint      NOT NULL,
  -- The store's words for how it was paid and sent, as PAID or FULFILLED.
  financial_status   text,
  fulfillment_status text,
  -- [{ title, variantTitle, sku, quantity, price }], price in minor units, as a string.
  lines              jsonb       NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
  -- { name, phone, address1, address2, city, province, zip, countryCode }; null for none.
  shipping_address   jsonb,
  note               text        NOT NULL DEFAULT '',
  customer_erased_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, source, source_id)
);

SELECT platform.enable_tenant_isolation('orders.past_orders');

CREATE INDEX past_orders_placed ON orders.past_orders (shop_id, placed_at DESC, id DESC);
CREATE INDEX past_orders_customer
  ON orders.past_orders (shop_id, customer_id, placed_at DESC) WHERE customer_id IS NOT NULL;
