-- 0087 · Order attribution
-- Where a shopper came to the online store from before they ordered (ORD-13, ADR-139): their
-- first and last visits from elsewhere in the 30 days before, each with when it was, the page it
-- landed on, the site that linked to it, where it came from and its UTM parameters. The shopper's
-- browser keeps them in a cookie of the shop's, the storefront passes them when checkout starts,
-- and the checkout keeps them for the order it places. Erasing a customer's data clears the
-- pages, keeping where their orders came from for the shop's sales by campaign.

ALTER TABLE checkout.checkouts
  ADD COLUMN attribution jsonb CHECK (jsonb_typeof(attribution) = 'object');

ALTER TABLE orders.orders
  ADD COLUMN attribution jsonb CHECK (jsonb_typeof(attribution) = 'object');
