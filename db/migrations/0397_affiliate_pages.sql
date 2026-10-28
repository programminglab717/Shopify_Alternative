-- 0397 · Affiliates' own pages (MKT-08)
-- An affiliate sees their own figures at a secret link the shop sends them, /a/<secret>: their
-- link, code and share, what their orders came to and earned, and their latest orders, nothing
-- of their customers (ADR-899). Hatti keeps the secret's digest alone; a new link replaces it.
-- See ADR-899 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.affiliates ADD COLUMN page_token_hash bytea;

CREATE UNIQUE INDEX affiliates_page_token ON orders.affiliates (page_token_hash)
  WHERE page_token_hash IS NOT NULL;

-- Finds the affiliate behind a page's secret, of an active shop, before the shop is known.
CREATE FUNCTION orders.resolve_affiliate_page(p_token_hash bytea)
  RETURNS TABLE (shop_id uuid, affiliate_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT a.shop_id, a.id
    FROM orders.affiliates a
    JOIN control.shops s ON s.id = a.shop_id
   WHERE a.page_token_hash = p_token_hash
     AND s.status = 'active'
$$;

ALTER FUNCTION orders.resolve_affiliate_page(bytea) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION orders.resolve_affiliate_page(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orders.resolve_affiliate_page(bytea) TO hatti_app_role;
