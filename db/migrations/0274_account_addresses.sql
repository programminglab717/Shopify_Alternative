-- 0274 · Shoppers' address books
-- A signed-in shopper keeps the addresses they deliver to with their account on the storefront
-- (CUS-02, ADR-583), as Shopify's customers do: each checked as checkout's shipping address is and
-- kept in its shape, one of them the default while there are any, at most 20. The book is the
-- customer's whose number signed in; a number no customer has yet keeps none, its addresses coming
-- with its first order. Merged into another customer, a customer's addresses join the other's,
-- whose default stays; erased, they go. See ADR-583 in docs/architecture/13-decision-log.md.

CREATE TABLE checkout.account_addresses (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL DEFAULT platform.uuidv7(),
  customer_id uuid        NOT NULL,
  -- As orders.orders keeps a shipping address: name, phone, address1, address2, landmark, city,
  -- provinceCode, zip and location.
  address     jsonb       NOT NULL CHECK (jsonb_typeof(address) = 'object'),
  is_default  boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id)
);

SELECT platform.enable_tenant_isolation('checkout.account_addresses');

CREATE INDEX account_addresses_customer ON checkout.account_addresses (shop_id, customer_id);
-- One default in a book.
CREATE UNIQUE INDEX account_addresses_default
  ON checkout.account_addresses (shop_id, customer_id) WHERE is_default;
