-- 0246 · Discount codes on drafts
-- A draft order can carry one of the shop's discount codes, as Shopify's draft orders take one
-- (CHK-06, ORD-03): checked against its items as checkout checks a cart's, setting what comes off
-- them, or making delivery free, and counted as a use once the draft becomes an order, in the
-- same transaction, refused then if its uses ran out or the customer used it already. See
-- ADR-521 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.draft_orders
  ADD COLUMN discount_code text CHECK (discount_code ~ '^[A-Za-z0-9_-]{1,64}$');
