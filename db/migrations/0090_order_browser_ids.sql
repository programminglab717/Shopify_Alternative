-- 0090 · Orders' browser IDs
-- A shop's storefront loads its Meta pixel while Meta is connected (MKT-10, ADR-144), and the
-- pixel names the shopper's browser in cookies on the shop's address: its browser ID, and the
-- click on an ad that brought it. Placing an order through checkout passes them on, for the
-- order's conversions to name the same browser the pixel's events did. Erasing a customer's data
-- clears them.

ALTER TABLE orders.orders
  ADD COLUMN browser_ids jsonb
    CHECK (jsonb_typeof(browser_ids) = 'object' AND octet_length(browser_ids::text) <= 2048);
