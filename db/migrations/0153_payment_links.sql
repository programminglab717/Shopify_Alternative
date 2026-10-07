-- 0153 · Payment links
-- A link the shop shares once, on WhatsApp, Instagram or anywhere, that many customers open, each
-- to a checkout of their own with the link's items, its discount code applied, and only the ways
-- to pay it allows, placing an order of their own (PAY-04). It may stop after so many orders or
-- at a time, or be closed by staff. Its secret is in its address, which the shop copies again
-- whenever it likes, so it is kept as it is: it names a public offer, and opens nothing private.
-- See ADR-248 in docs/architecture/13-decision-log.md.

CREATE TABLE checkout.payment_links (
  shop_id       uuid        NOT NULL,
  id            uuid        NOT NULL,
  -- 128 random bits in base64url: its address, /pay/<token>.
  token         text        NOT NULL CHECK (token ~ '^[A-Za-z0-9_-]{22}$'),
  -- For staff, as they find it among the shop's links.
  title         text        NOT NULL CHECK (length(title) BETWEEN 1 AND 255),
  -- [{"variantId": "…", "quantity": 2}], in the shop's order.
  items         jsonb       NOT NULL
                            CHECK (jsonb_typeof(items) = 'array'
                                   AND jsonb_array_length(items) BETWEEN 1 AND 20),
  -- Applied to each checkout it opens, as the shop wrote it; null for none.
  discount_code text        CHECK (length(discount_code) BETWEEN 1 AND 255),
  -- Paid before it ships, by transfer or online: cash on delivery is not offered.
  prepaid_only  boolean     NOT NULL DEFAULT false,
  -- How many orders it takes before it closes; null for no limit.
  usage_limit   integer     CHECK (usage_limit BETWEEN 1 AND 100000),
  -- The orders placed through it so far.
  orders_placed integer     NOT NULL DEFAULT 0 CHECK (orders_placed >= 0),
  last_order_at timestamptz,
  expires_at    timestamptz,
  active        boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, token)
);

SELECT platform.enable_tenant_isolation('checkout.payment_links');

-- The link a checkout was opened from, whose rules it keeps until its order is placed.
ALTER TABLE checkout.checkouts ADD COLUMN payment_link_id uuid;
