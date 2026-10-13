-- 0192 · Bundles and multipacks (CAT-11)
-- A product the shop sells as a set of others: "3-piece lawn suits" of three variants, or a
-- multipack, three of one. It has one variant of its own, whose price is the set's; what it is
-- made of sells from their stock, and orders keep those parts as their lines.
-- See ADR-409 in docs/architecture/13-decision-log.md.

CREATE TABLE catalog.bundles (
  shop_id    uuid        NOT NULL,
  product_id uuid        NOT NULL,
  -- How many parts it was given: a part whose variant is deleted goes with it, and a bundle
  -- with fewer parts than this is not sold until the shop gives it its parts again.
  parts      smallint    NOT NULL CHECK (parts BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, product_id),
  FOREIGN KEY (shop_id, product_id) REFERENCES catalog.products (shop_id, id) ON DELETE CASCADE
);
SELECT platform.enable_tenant_isolation('catalog.bundles');

CREATE TABLE catalog.bundle_components (
  shop_id    uuid     NOT NULL,
  product_id uuid     NOT NULL,
  variant_id uuid     NOT NULL,
  -- How many of it one bundle holds.
  quantity   smallint NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  position   smallint NOT NULL CHECK (position >= 1),
  PRIMARY KEY (shop_id, product_id, variant_id),
  FOREIGN KEY (shop_id, product_id) REFERENCES catalog.bundles (shop_id, product_id)
    ON DELETE CASCADE,
  FOREIGN KEY (shop_id, variant_id) REFERENCES catalog.variants (shop_id, id) ON DELETE CASCADE
);
CREATE INDEX bundle_components_variant_idx ON catalog.bundle_components (shop_id, variant_id);
SELECT platform.enable_tenant_isolation('catalog.bundle_components');

-- The bundle a line was sold as: its parts' lines share it, with the bundle's title and how many
-- of it were ordered. Null for a line sold on its own.
ALTER TABLE orders.lines
  ADD COLUMN bundle_key      uuid,
  ADD COLUMN bundle_title    text CHECK (length(bundle_title) BETWEEN 1 AND 255),
  ADD COLUMN bundle_quantity integer CHECK (bundle_quantity >= 1),
  ADD CONSTRAINT lines_bundle_check CHECK (
    (bundle_key IS NULL) = (bundle_title IS NULL) AND (bundle_key IS NULL) = (bundle_quantity IS NULL)
  );
