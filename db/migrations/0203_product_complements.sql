-- 0203 · Complementary products
-- The products a shop pairs with one (MKT-09), as Shopify's Search & Discovery keeps them: shown
-- in order where its page or cart asks for complementary recommendations. At most ten a product.
-- See ADR-435 in docs/architecture/13-decision-log.md.

CREATE TABLE catalog.product_complements (
  shop_id       uuid     NOT NULL,
  product_id    uuid     NOT NULL,
  complement_id uuid     NOT NULL,
  -- Where it comes among the product's pairings, from 0.
  position      smallint NOT NULL CHECK (position BETWEEN 0 AND 9),
  PRIMARY KEY (shop_id, product_id, complement_id),
  UNIQUE (shop_id, product_id, position),
  CHECK (product_id <> complement_id),
  FOREIGN KEY (shop_id, product_id) REFERENCES catalog.products (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, complement_id) REFERENCES catalog.products (shop_id, id) ON DELETE CASCADE
);
-- The products pairing with one, rebuilt when it is deleted or changes.
CREATE INDEX product_complements_complement_idx
  ON catalog.product_complements (shop_id, complement_id);
SELECT platform.enable_tenant_isolation('catalog.product_complements');
