-- 0193 · Gift options at checkout (CHK-16)
-- A shop may sell gift wrap, one of its own variants the checkout's page adds to the cart when
-- the shopper asks, and may let shoppers write a gift message, which the order keeps for its
-- packing slip. See ADR-413 in docs/architecture/13-decision-log.md.

CREATE TABLE checkout.gift_options (
  shop_id         uuid        PRIMARY KEY,
  -- The variant sold as gift wrap; none for no wrap. The catalog's: a variant deleted, or its
  -- product not for sale, is not offered.
  wrap_variant_id uuid,
  -- Whether the checkout's page asks for a gift message.
  messages        boolean     NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
SELECT platform.enable_tenant_isolation('checkout.gift_options');

ALTER TABLE orders.orders
  ADD COLUMN gift_message text CHECK (length(gift_message) BETWEEN 1 AND 250);
