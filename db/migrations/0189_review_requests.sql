-- 0189 · Reviews asked for on WhatsApp (MKT-05)
-- A shop may ask the customers of its delivered orders for a review, as many days after the
-- order's last parcel arrived as it says: once an order, with the order's page to rate what it
-- brought. See ADR-400 in docs/architecture/13-decision-log.md.

-- How many days after delivery the shop asks, 1 to 14, while the order's page still opens (its
-- link lasts 30 days past the order's end); null: it does not.
ALTER TABLE catalog.review_settings
  ADD COLUMN request_after_days smallint CHECK (request_after_days BETWEEN 1 AND 14);

-- When its customer was asked to review what it brought, once.
ALTER TABLE orders.orders ADD COLUMN review_requested_at timestamptz;
-- The orders to ask about are found by their parcels' delivery, through
-- fulfillments_delivered_idx (migration 0076).

