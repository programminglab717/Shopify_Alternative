-- 0018 · Draft orders
-- Orders taken in a chat before they are placed: the items at the prices agreed, and the
-- customer's address once they send it. Staff place a draft when the customer agrees, or send the
-- customer a link to confirm it, which places it. Drafts hold no stock: placing one commits it.
-- See docs/architecture/05-checkout-and-payments.md §7 and docs/engineering/conventions.md.

-- Drafts are numbered #D1 onwards, per shop, beside the shop's order numbers.
ALTER TABLE orders.counters
  ADD COLUMN next_draft_number integer NOT NULL DEFAULT 1 CHECK (next_draft_number > 0);

CREATE TABLE orders.draft_orders (
  shop_id          uuid        NOT NULL,
  id               uuid        NOT NULL,
  number           integer     NOT NULL CHECK (number > 0),
  status           text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed')),
  -- Where the conversation happened; the order takes it.
  source           text        NOT NULL
                   CHECK (source IN ('whatsapp', 'instagram', 'facebook', 'manual', 'api')),
  payment_method   text        NOT NULL CHECK (payment_method IN ('cash_on_delivery', 'prepaid')),
  currency         text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- The items at the prices agreed, as they were when added: [{variantId, productId, title,
  -- variantTitle, sku, quantity, unitPrice}], with unitPrice in minor units as a string.
  lines            jsonb       NOT NULL
                   CHECK (jsonb_typeof(lines) = 'array'
                          AND jsonb_array_length(lines) BETWEEN 1 AND 100),
  -- Minor units in `currency`, as on orders.
  subtotal         bigint      NOT NULL CHECK (subtotal >= 0),
  discount         bigint      NOT NULL CHECK (discount >= 0),
  shipping         bigint      NOT NULL CHECK (shipping >= 0),
  total            bigint      NOT NULL,
  advance_paid     bigint      NOT NULL CHECK (advance_paid >= 0),
  -- The customer's mobile number (E.164) and address, both or neither: in a chat they often
  -- come after the items. A draft needs them to be placed or sent.
  phone            text        CHECK (phone ~ '^\+923[0-9]{9}$'),
  email            text        CHECK (length(email) BETWEEN 3 AND 254),
  shipping_address jsonb,
  -- Where the order will ship from; the primary location when it is placed, if null. No foreign
  -- key: the location belongs to the inventory module.
  location_id      uuid,
  note             text        NOT NULL DEFAULT '' CHECK (length(note) <= 5000),
  tags             text[]      NOT NULL DEFAULT '{}',
  -- The order it became.
  order_id         uuid,
  -- The customer's link to confirm it. Only a SHA-256 digest of the link's secret is kept; a
  -- new link replaces the old one.
  link_token_hash  bytea       CHECK (octet_length(link_token_hash) = 32),
  link_expires_at  timestamptz,
  -- Who started it: the access token or the staff member.
  actor_kind       text        NOT NULL CHECK (actor_kind IN ('app', 'staff')),
  actor_id         uuid        NOT NULL,
  version          integer     NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  PRIMARY KEY (shop_id, id),
  CONSTRAINT draft_orders_number_key UNIQUE (shop_id, number),
  CONSTRAINT draft_orders_total_check
    CHECK (discount <= subtotal AND total = subtotal - discount + shipping),
  -- An advance is part of a cash-on-delivery order; a prepaid order is paid in full.
  CONSTRAINT draft_orders_advance_check
    CHECK (advance_paid <= total AND (payment_method = 'cash_on_delivery' OR advance_paid = 0)),
  CONSTRAINT draft_orders_address_check CHECK ((phone IS NULL) = (shipping_address IS NULL)),
  CONSTRAINT draft_orders_completed_check
    CHECK ((status = 'completed') = (order_id IS NOT NULL)
           AND (status = 'completed') = (completed_at IS NOT NULL)),
  -- A link confirms a cash-on-delivery order, so it needs one, with the address to send it to.
  CONSTRAINT draft_orders_link_check
    CHECK ((link_token_hash IS NULL) = (link_expires_at IS NULL)
           AND (link_token_hash IS NULL
                OR (payment_method = 'cash_on_delivery' AND phone IS NOT NULL))),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders.orders (shop_id, id)
);

CREATE INDEX draft_orders_status_idx ON orders.draft_orders (shop_id, status, id DESC);
-- An order comes from one draft at most.
CREATE UNIQUE INDEX draft_orders_order_key ON orders.draft_orders (shop_id, order_id);
-- Links are looked up before the shop is known, so this index cannot lead with shop_id.
CREATE UNIQUE INDEX draft_orders_link_key ON orders.draft_orders (link_token_hash);

SELECT platform.enable_tenant_isolation('orders.draft_orders');

-- The shop and draft of a link, for the customer's page, which knows no shop until it finds one.
-- SECURITY DEFINER lets request code find a link without seeing any other shop's drafts; it
-- returns nothing for shops that are not active. Whether the link has expired is the caller's to
-- say.
CREATE FUNCTION orders.resolve_draft_order_link(p_token_hash bytea)
  RETURNS TABLE (shop_id uuid, draft_order_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT d.shop_id, d.id
    FROM orders.draft_orders d
    JOIN control.shops s ON s.id = d.shop_id
   WHERE d.link_token_hash = p_token_hash
     AND s.status = 'active'
$$;

ALTER FUNCTION orders.resolve_draft_order_link(bytea) OWNER TO hatti_system_role;
REVOKE ALL ON FUNCTION orders.resolve_draft_order_link(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orders.resolve_draft_order_link(bytea) TO hatti_app_role;
