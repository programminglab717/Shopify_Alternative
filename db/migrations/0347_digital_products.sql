-- 0347 · Digital products
-- A product sold as files to download or licence keys, needing no delivery (CAT-13): how many
-- times each unit's link downloads and for how many days, and whether each unit is given a key.
-- Its files are the shop's own, kept privately under the shop's prefix apart from those its pages
-- show, uploaded through a URL the Admin API signs and staged until then, as files are (ADR-079).
-- Its keys are a pool the shop fills, each kept encrypted, with a digest that keeps them unique;
-- each is issued once, to one unit of an order's line. See ADR-813 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE catalog.digital_products (
  shop_id         uuid        NOT NULL,
  product_id      uuid        NOT NULL,
  -- How many times a unit's link downloads each file.
  download_limit  smallint    NOT NULL DEFAULT 5 CHECK (download_limit BETWEEN 1 AND 50),
  -- How many days a unit's link lasts.
  link_days       smallint    NOT NULL DEFAULT 30 CHECK (link_days BETWEEN 1 AND 365),
  -- Whether each unit is given one of the product's licence keys.
  licence_keys    boolean     NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, product_id),
  FOREIGN KEY (shop_id, product_id) REFERENCES catalog.products (shop_id, id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('catalog.digital_products');

CREATE TABLE catalog.digital_files (
  shop_id       uuid        NOT NULL,
  id            uuid        NOT NULL,
  product_id    uuid        NOT NULL,
  -- Where storage keeps it: shops/{shop_id}/digital/{id}/{name}, never shown on the shop's pages.
  key           text        NOT NULL CHECK (key LIKE 'shops/' || shop_id || '/digital/' || id || '/%'),
  filename      text        NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
  content_type  text        NOT NULL CHECK (content_type ~ '^[a-z]+/[a-z0-9.+-]{1,100}$'),
  -- Bytes; at most 2 GiB.
  size          bigint      NOT NULL CHECK (size BETWEEN 1 AND 2147483648),
  status        text        NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'ready')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, product_id)
    REFERENCES catalog.digital_products (shop_id, product_id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('catalog.digital_files');

CREATE INDEX digital_files_product ON catalog.digital_files (shop_id, product_id, created_at);

CREATE TABLE catalog.licence_keys (
  shop_id       uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT platform.uuidv7(),
  product_id    uuid        NOT NULL,
  -- The key, encrypted with the platform's secret box; its last four characters, to tell it.
  sealed        text        NOT NULL,
  hint          text        NOT NULL CHECK (char_length(hint) BETWEEN 1 AND 4),
  -- SHA-256 of the key as typed, trimmed: a product's keys are each given once.
  digest        bytea       NOT NULL,
  -- The order line's unit it was issued to.
  order_id      uuid,
  line_item_id  uuid,
  line_unit     smallint    CHECK (line_unit >= 1),
  issued_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, product_id, digest),
  FOREIGN KEY (shop_id, product_id)
    REFERENCES catalog.digital_products (shop_id, product_id) ON DELETE CASCADE,
  CHECK ((issued_at IS NULL) = (order_id IS NULL)
         AND (order_id IS NULL) = (line_item_id IS NULL)
         AND (line_item_id IS NULL) = (line_unit IS NULL))
);

SELECT platform.enable_tenant_isolation('catalog.licence_keys');

-- Each unit of an order's line is given one key, once.
CREATE UNIQUE INDEX licence_keys_line_unit
  ON catalog.licence_keys (shop_id, line_item_id, line_unit) WHERE line_item_id IS NOT NULL;
-- The keys left to give, oldest first.
CREATE INDEX licence_keys_left ON catalog.licence_keys (shop_id, product_id, created_at)
  WHERE issued_at IS NULL;
