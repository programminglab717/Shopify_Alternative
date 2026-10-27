-- 0348 · Digital products delivered
-- Once an order is paid, each of its lines of a digital product (CAT-13) is given a link of its
-- own to the product's files: a random token kept as its SHA-256, lasting the product's days, each
-- file downloading as many times as the product allows for each unit. Its downloads are counted
-- by file. The link's page is found from its token alone, before any shop is known, as an order's
-- link is (0019). See ADR-814 in docs/architecture/13-decision-log.md.

CREATE TABLE catalog.digital_deliveries (
  shop_id         uuid        NOT NULL,
  id              uuid        NOT NULL DEFAULT platform.uuidv7(),
  token_hash      bytea       NOT NULL,
  order_id        uuid        NOT NULL,
  line_item_id    uuid        NOT NULL,
  product_id      uuid        NOT NULL,
  units           integer     NOT NULL CHECK (units >= 1),
  -- How many times each file downloads in all: the product's limit for each unit.
  download_limit  integer     NOT NULL CHECK (download_limit >= 1),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  -- Each line is delivered once.
  UNIQUE (shop_id, line_item_id)
);

SELECT platform.enable_tenant_isolation('catalog.digital_deliveries');

CREATE UNIQUE INDEX digital_deliveries_token ON catalog.digital_deliveries (token_hash);
CREATE INDEX digital_deliveries_order ON catalog.digital_deliveries (shop_id, order_id);

CREATE TABLE catalog.digital_downloads (
  shop_id      uuid    NOT NULL,
  delivery_id  uuid    NOT NULL,
  file_id      uuid    NOT NULL,
  count        integer NOT NULL CHECK (count >= 0),
  PRIMARY KEY (shop_id, delivery_id, file_id),
  FOREIGN KEY (shop_id, delivery_id)
    REFERENCES catalog.digital_deliveries (shop_id, id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('catalog.digital_downloads');

-- The delivery a link's token names, before any shop is known: an active shop's alone.
CREATE FUNCTION catalog.resolve_digital_delivery(p_token_hash bytea)
  RETURNS TABLE (shop_id uuid, delivery_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT d.shop_id, d.id
    FROM catalog.digital_deliveries d
    JOIN control.shops s ON s.id = d.shop_id
   WHERE d.token_hash = p_token_hash
     AND s.status = 'active'
$$;

ALTER FUNCTION catalog.resolve_digital_delivery(bytea) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION catalog.resolve_digital_delivery(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog.resolve_digital_delivery(bytea) TO hatti_app_role;
