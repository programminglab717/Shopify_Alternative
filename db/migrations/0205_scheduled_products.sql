-- 0205 · Products published at a time ahead
-- A draft product given a time ahead goes on sale by itself when it comes (CAT-17), as an Eid
-- drop "goes live at 00:00": the worker makes it active, with the product.updated the storefront
-- follows. Null for none; it goes once the product is on sale or archived by hand.
-- See ADR-441 in docs/architecture/13-decision-log.md.

ALTER TABLE catalog.products ADD COLUMN publish_at timestamptz;

-- The products whose time comes, as the worker finds them.
CREATE INDEX products_publish_at_idx ON catalog.products (publish_at) WHERE publish_at IS NOT NULL;
