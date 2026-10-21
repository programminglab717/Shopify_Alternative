-- 0302 · An order line's properties
-- A cart's line keeps what the shopper wrote or chose for it, Shopify's line item properties, a
-- name to embroider or a colour of thread; orders kept them only in their note. An order's line
-- now keeps them as they were, Shopify's customAttributes. See ADR-687 in
-- docs/architecture/13-decision-log.md.

-- Each name and its value as the cart had them; those whose names begin "_" are apps', not shown.
ALTER TABLE orders.lines
  ADD COLUMN properties jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(properties) = 'object');
