-- 0042 · Parcels the courier lost
-- A parcel the courier lost, on its way out or back, is written off (COD-09): it is `lost`, with
-- when it was marked so, and an order whose every parcel was lost is at the `lost` stage, done
-- like one returned, apart from it: a refusal is the customer's, a loss the courier's. See
-- ADR-072 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.fulfillments ADD COLUMN lost_at timestamptz;
ALTER TABLE orders.fulfillments DROP CONSTRAINT fulfillments_status_check;
ALTER TABLE orders.fulfillments
  ADD CONSTRAINT fulfillments_status_check
      CHECK (status IN ('in_transit', 'delivered', 'returning', 'returned', 'lost'));
-- A lost parcel that turns up is checked back in, keeping when it was lost.
ALTER TABLE orders.fulfillments
  ADD CONSTRAINT fulfillments_lost_check CHECK (status <> 'lost' OR lost_at IS NOT NULL);

ALTER TABLE orders.orders DROP CONSTRAINT orders_stage_check;
ALTER TABLE orders.orders
  ADD CONSTRAINT orders_stage_check
      CHECK (stage IN ('needs_confirmation', 'needs_review', 'to_pack', 'to_book',
                       'partially_fulfilled', 'in_transit', 'returning', 'delivered', 'returned',
                       'lost', 'completed', 'cancelled'));
