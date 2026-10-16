-- 0206 · Sales set ahead (CAT-17)
-- A percentage off a shop's chosen products from a time to a time, for an Eid or 11.11 sale: when
-- it starts, each variant's price is cut and its old price shown as the compare-at price; when it
-- ends, both come back, unless the shop changed the price by hand meanwhile.
-- See ADR-443 in docs/architecture/13-decision-log.md.

CREATE TABLE catalog.price_sales (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL DEFAULT platform.uuidv7(),
  name        text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  percent_off smallint    NOT NULL CHECK (percent_off BETWEEN 1 AND 90),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  -- scheduled → running → ended; or cancelled before it starts.
  state       text        NOT NULL DEFAULT 'scheduled'
    CHECK (state IN ('scheduled', 'running', 'ended', 'cancelled')),
  ended_at    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CHECK (ends_at > starts_at),
  CHECK ((state = 'ended') = (ended_at IS NOT NULL))
);
-- The sweep's lookups: those to start, and those to end.
CREATE INDEX price_sales_starts_idx ON catalog.price_sales (starts_at) WHERE state = 'scheduled';
CREATE INDEX price_sales_ends_idx ON catalog.price_sales (ends_at) WHERE state = 'running';
SELECT platform.enable_tenant_isolation('catalog.price_sales');

-- The products a sale takes, in no order.
CREATE TABLE catalog.price_sale_products (
  shop_id    uuid NOT NULL,
  sale_id    uuid NOT NULL,
  product_id uuid NOT NULL,
  PRIMARY KEY (shop_id, sale_id, product_id),
  FOREIGN KEY (shop_id, sale_id) REFERENCES catalog.price_sales (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, product_id) REFERENCES catalog.products (shop_id, id) ON DELETE CASCADE
);
CREATE INDEX price_sale_products_product_idx ON catalog.price_sale_products (shop_id, product_id);
SELECT platform.enable_tenant_isolation('catalog.price_sale_products');

-- Each variant's prices before the sale, kept when it starts to put back when it ends, and the
-- price the sale gave it, to tell whether the shop changed it since.
CREATE TABLE catalog.price_sale_variants (
  shop_id          uuid   NOT NULL,
  sale_id          uuid   NOT NULL,
  variant_id       uuid   NOT NULL,
  price            bigint NOT NULL CHECK (price >= 0),
  compare_at_price bigint CHECK (compare_at_price >= 0),
  sale_price       bigint NOT NULL CHECK (sale_price >= 0),
  PRIMARY KEY (shop_id, sale_id, variant_id),
  FOREIGN KEY (shop_id, sale_id) REFERENCES catalog.price_sales (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, variant_id) REFERENCES catalog.variants (shop_id, id) ON DELETE CASCADE
);
SELECT platform.enable_tenant_isolation('catalog.price_sale_variants');
