-- 0019 · Order links
-- A link for an order's customer, as draft orders have (0018): a page where they confirm or
-- cancel a cash-on-delivery order that waits for them, and see how the order is doing after. The
-- tap-to-confirm link of the confirmation sequence. See
-- docs/architecture/06-orders-fulfillment-logistics.md §3 and docs/engineering/conventions.md.

ALTER TABLE orders.orders
  -- Only a SHA-256 digest of the link's secret is kept; a new link replaces the old one.
  ADD COLUMN link_token_hash bytea CHECK (octet_length(link_token_hash) = 32),
  ADD COLUMN link_expires_at timestamptz,
  ADD CONSTRAINT orders_link_check
    CHECK ((link_token_hash IS NULL) = (link_expires_at IS NULL)),
  -- The page shows the customer's address, so erasing their details takes the link too.
  ADD CONSTRAINT orders_link_customer_check
    CHECK (link_token_hash IS NULL OR phone IS NOT NULL);

-- Links are looked up before the shop is known, so this index cannot lead with shop_id.
CREATE UNIQUE INDEX orders_link_key ON orders.orders (link_token_hash);

-- The shop and order of a link, for the customer's page, as for drafts' links.
CREATE FUNCTION orders.resolve_order_link(p_token_hash bytea)
  RETURNS TABLE (shop_id uuid, order_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT o.shop_id, o.id
    FROM orders.orders o
    JOIN control.shops s ON s.id = o.shop_id
   WHERE o.link_token_hash = p_token_hash
     AND s.status = 'active'
$$;

ALTER FUNCTION orders.resolve_order_link(bytea) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION orders.resolve_order_link(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orders.resolve_order_link(bytea) TO hatti_app_role;
