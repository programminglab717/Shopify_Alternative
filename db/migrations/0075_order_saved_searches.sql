-- 0075 · Saved order searches
-- Searches of the orders list the shop keeps by name, shop-wide, as Shopify's saved searches:
-- each a query as orders(query:) takes it, checked when saved (ADR-119).
CREATE TABLE orders.saved_searches (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL,
  name       text        NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  query      text        NOT NULL CHECK (length(query) BETWEEN 1 AND 1000),
  version    integer     NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

-- Names are unique per shop, ignoring case, as the tabs they name are.
CREATE UNIQUE INDEX saved_searches_name_key ON orders.saved_searches (shop_id, lower(name));

SELECT platform.enable_tenant_isolation('orders.saved_searches');
