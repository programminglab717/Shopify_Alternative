-- 0026 · Carts
-- Shoppers' carts: the variants they chose, how many of each, and what they typed for each line,
-- with the cart's note and attributes. A cart holds no prices: the catalog and inventory are read
-- whenever it is, so a cart always shows today's. Storefronts find a cart by the secret in the
-- shopper's cart cookie, of which Hatti keeps only the SHA-256; it lasts 14 days after its last
-- change. See ADR-042 in docs/architecture/13-decision-log.md.

CREATE SCHEMA checkout;

GRANT USAGE ON SCHEMA checkout TO hatti_app_role, hatti_system_role;

CREATE TABLE checkout.carts (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL DEFAULT platform.uuidv7(),
  token_hash bytea       NOT NULL CHECK (octet_length(token_hash) = 32),
  -- [{"variantId", "quantity", "properties"}], the newest line first; as many as an order takes.
  lines      jsonb       NOT NULL DEFAULT '[]'
                         CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) <= 100),
  note       text        NOT NULL DEFAULT '' CHECK (length(note) <= 5000),
  attributes jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(attributes) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, token_hash)
);

-- For sweeping a shop's expired carts.
CREATE INDEX carts_expires_at_idx ON checkout.carts (shop_id, expires_at);

SELECT platform.enable_tenant_isolation('checkout.carts');
