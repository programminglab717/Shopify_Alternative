-- 0351 · Drops
-- A drop the shop schedules (INV-09, OS-17): products that go on sale together at a time, such
-- as a lawn collection at midnight, until an end. Until it starts, its products sell to no one;
-- its drafts go on sale at its start, as products scheduled to are (ADR-441). While it is live,
-- each customer, by their number, may buy so many units of each of its products at most. Its
-- waiting room's rate is kept here for the storefront (ADR-822). See ADR-820 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE catalog.drops (
  shop_id          uuid        NOT NULL,
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  name             text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  -- Units of each of its products a customer may buy while it is live; null for no limit.
  per_customer     smallint    CHECK (per_customer BETWEEN 1 AND 100),
  -- Shoppers its waiting room lets in a minute; null for none.
  admit_per_minute integer     CHECK (admit_per_minute BETWEEN 10 AND 100000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '7 days')
);

SELECT platform.enable_tenant_isolation('catalog.drops');

CREATE TABLE catalog.drop_products (
  shop_id     uuid NOT NULL,
  drop_id     uuid NOT NULL,
  product_id  uuid NOT NULL,
  PRIMARY KEY (shop_id, drop_id, product_id),
  FOREIGN KEY (shop_id, drop_id) REFERENCES catalog.drops (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, product_id) REFERENCES catalog.products (shop_id, id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('catalog.drop_products');

-- A product's drops, as carts ask of each line.
CREATE INDEX drop_products_product_idx ON catalog.drop_products (shop_id, product_id);
