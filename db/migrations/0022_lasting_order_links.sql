-- 0022 · Order links that last
-- An order's link works until 30 days after the order ends, closed or cancelled, so its customer
-- can follow the parcel however long it takes to come. Such a link has no expiry of its own; one
-- made to work for a set number of hours keeps it. See ADR-038 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE orders.orders
  DROP CONSTRAINT orders_link_check,
  ADD CONSTRAINT orders_link_check CHECK (link_token_hash IS NOT NULL OR link_expires_at IS NULL);
