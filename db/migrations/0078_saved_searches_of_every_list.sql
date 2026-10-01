-- 0078 · Saved searches of products and drafts
-- A saved search names the list it searches, as Shopify's resourceType does: orders, drafts or
-- products, each query checked as its own list's search checks it (ADR-124). Names are unique in a
-- list, in any letter case, and a shop keeps up to 100 of each list's.

ALTER TABLE orders.saved_searches
  ADD COLUMN resource_type text NOT NULL DEFAULT 'order'
    CHECK (resource_type IN ('order', 'draft_order', 'product'));
ALTER TABLE orders.saved_searches ALTER COLUMN resource_type DROP DEFAULT;

DROP INDEX orders.saved_searches_name_key;
CREATE UNIQUE INDEX saved_searches_name_key
  ON orders.saved_searches (shop_id, resource_type, lower(name));
