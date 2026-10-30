-- 0432 · Products a shopper viewed, kept with their account
-- A shopper's recently viewed products are kept in their browser (ADR-961); signed in, they are
-- kept with their account too, so that they follow the shopper to any device they sign in on.
-- They are kept beside the wishlist (ADR-575), whose owner, merge, erasure and expiry they share:
-- each item says which list it is in. Viewed again, a product moves to the top; the newest twenty
-- are kept. See ADR-978 in docs/architecture/13-decision-log.md.

ALTER TABLE checkout.account_wishlist_items
  ADD COLUMN list text NOT NULL DEFAULT 'wishlist' CHECK (list IN ('wishlist', 'viewed'));

-- A product once in each list.
DROP INDEX checkout.account_wishlist_items_customer;
DROP INDEX checkout.account_wishlist_items_phone;
CREATE UNIQUE INDEX account_wishlist_items_customer
  ON checkout.account_wishlist_items (shop_id, list, customer_id, product_id)
  WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX account_wishlist_items_phone
  ON checkout.account_wishlist_items (shop_id, list, phone, product_id)
  WHERE phone IS NOT NULL;
