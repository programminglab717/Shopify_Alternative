-- 0028 · Checkouts
-- A shopper's way from their cart to an order: a page at an address carrying a secret of its own,
-- of which Hatti keeps only the SHA-256, and the order it placed. It keeps nothing the shopper
-- types until the order has it. See ADR-044 in docs/architecture/13-decision-log.md.

CREATE TABLE checkout.checkouts (
  shop_id      uuid        NOT NULL,
  id           uuid        NOT NULL,
  token_hash   bytea       NOT NULL CHECK (octet_length(token_hash) = 32),
  -- The cart it checks out; null once the cart is gone.
  cart_id      uuid,
  -- The order it placed, in the orders module; set with completed_at.
  order_id     uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, cart_id) REFERENCES checkout.carts (shop_id, id) ON DELETE SET NULL (cart_id),
  CHECK ((order_id IS NULL) = (completed_at IS NULL))
);

CREATE UNIQUE INDEX checkouts_token_key ON checkout.checkouts (token_hash);
-- For sweeping a shop's expired checkouts.
CREATE INDEX checkouts_expires_at_idx ON checkout.checkouts (shop_id, expires_at);

SELECT platform.enable_tenant_isolation('checkout.checkouts');

-- The shop and checkout of a secret, for the checkout's page, which knows no shop until it finds
-- one. SECURITY DEFINER lets request code find a checkout without seeing any other shop's; it
-- returns nothing for shops that are not active. Whether it has expired is the caller's to say.
CREATE FUNCTION checkout.resolve_checkout(p_token_hash bytea)
  RETURNS TABLE (shop_id uuid, checkout_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT c.shop_id, c.id
    FROM checkout.checkouts c
    JOIN control.shops s ON s.id = c.shop_id
   WHERE c.token_hash = p_token_hash
     AND s.status = 'active'
$$;

ALTER FUNCTION checkout.resolve_checkout(bytea) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION checkout.resolve_checkout(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION checkout.resolve_checkout(bytea) TO hatti_app_role;
