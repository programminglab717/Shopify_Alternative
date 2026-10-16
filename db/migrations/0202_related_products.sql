-- 0202 · Related products
-- A product's page shows products related to it (MKT-09): those in the collections it is in, then
-- those of its type, then its vendor's, worked out as its storefront document is built. These find
-- the shop's products for sale of a type, or a vendor's, without reading the rest.
-- See ADR-434 in docs/architecture/13-decision-log.md.

CREATE INDEX products_active_type_idx ON catalog.products (shop_id, product_type)
  WHERE status = 'active' AND product_type IS NOT NULL;
CREATE INDEX products_active_vendor_idx ON catalog.products (shop_id, vendor)
  WHERE status = 'active' AND vendor IS NOT NULL;
