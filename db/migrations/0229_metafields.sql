-- 0229 · Metafields (CAT-06)
-- Custom data a shop keeps on its products, variants and collections, as Shopify's metafields:
-- each a namespace, a key, a type and a value, read by the Admin API and by themes' Liquid
-- (`product.metafields.custom.care.value`). Definitions name the shop's own fields and fix their
-- types, for the admin to show and fill. See ADR-489 in docs/architecture/13-decision-log.md.

CREATE TABLE catalog.metafield_definitions (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL DEFAULT platform.uuidv7(),
  owner_type  text        NOT NULL CHECK (owner_type IN ('product', 'variant', 'collection')),
  namespace   text        NOT NULL CHECK (namespace ~ '^[A-Za-z0-9_-]{2,64}$'),
  key         text        NOT NULL CHECK (key ~ '^[A-Za-z0-9_-]{2,64}$'),
  type        text        NOT NULL,
  name        text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description text        CHECK (length(description) BETWEEN 1 AND 300),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, owner_type, namespace, key)
);
SELECT platform.enable_tenant_isolation('catalog.metafield_definitions');

-- A value belongs to one product, variant or collection, and goes with it.
CREATE TABLE catalog.metafields (
  shop_id       uuid        NOT NULL,
  id            uuid        NOT NULL DEFAULT platform.uuidv7(),
  product_id    uuid,
  variant_id    uuid,
  collection_id uuid,
  namespace     text        NOT NULL CHECK (namespace ~ '^[A-Za-z0-9_-]{2,64}$'),
  key           text        NOT NULL CHECK (key ~ '^[A-Za-z0-9_-]{2,64}$'),
  type          text        NOT NULL,
  -- As Shopify keeps it: a string, JSON for the types made of more than one value.
  value         text        NOT NULL CHECK (length(value) BETWEEN 1 AND 65536),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CHECK (num_nonnulls(product_id, variant_id, collection_id) = 1),
  FOREIGN KEY (shop_id, product_id) REFERENCES catalog.products (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, variant_id) REFERENCES catalog.variants (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, collection_id) REFERENCES catalog.collections (shop_id, id)
    ON DELETE CASCADE
);
CREATE UNIQUE INDEX metafields_product_key ON catalog.metafields (shop_id, product_id, namespace, key)
  WHERE product_id IS NOT NULL;
CREATE UNIQUE INDEX metafields_variant_key ON catalog.metafields (shop_id, variant_id, namespace, key)
  WHERE variant_id IS NOT NULL;
CREATE UNIQUE INDEX metafields_collection_key
  ON catalog.metafields (shop_id, collection_id, namespace, key) WHERE collection_id IS NOT NULL;
SELECT platform.enable_tenant_isolation('catalog.metafields');
