-- 0270 · Shoppers' wishlists, kept with their account
-- A shopper's wishlist is kept in their browser (OS-12, ADR-418); signed in to their account on the
-- storefront (CUS-02, ADR-570), it is kept with the account too, so that it follows them to any
-- browser they sign in on. Each item is a product of the shop's, by the catalog's ID, with when it
-- was added: the newest first, at most 100, the oldest going to make room. It is the customer's
-- whose number signed in; a number no customer has yet keeps its own, which goes to the customer
-- the number becomes, as when it places its first order, the next time its account is read.
-- Merged into another customer, a customer's list joins the other's; erased, it goes, with the
-- lists of their numbers. A number's own list is kept while the number is signed in somewhere,
-- and goes with its last session. A product the shop no longer has leaves the list once it is
-- read. See ADR-575 in docs/architecture/13-decision-log.md.

CREATE TABLE checkout.account_wishlist_items (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- Whose it is: a customer, or, while a number signed in has none, the number (E.164).
  customer_id uuid,
  phone       text        CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  -- The catalog's product, as the storefront's documents name it.
  product_id  uuid        NOT NULL,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CHECK ((customer_id IS NULL) <> (phone IS NULL))
);

SELECT platform.enable_tenant_isolation('checkout.account_wishlist_items');

-- A product once in a list, each list read whole: 100 at most.
CREATE UNIQUE INDEX account_wishlist_items_customer
  ON checkout.account_wishlist_items (shop_id, customer_id, product_id)
  WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX account_wishlist_items_phone
  ON checkout.account_wishlist_items (shop_id, phone, product_id)
  WHERE phone IS NOT NULL;
