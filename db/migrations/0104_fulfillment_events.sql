-- 0104 · Fulfillment events
-- Each parcel's way to its customer, step by step (SHP-05), as Shopify's FulfillmentEvent keeps
-- it: booked with its courier, on its way, out for delivery, a delivery tried, delivered, or
-- coming back. The worker records what couriers say as they say it; staff and apps record what
-- couriers Hatti does not follow tell them. The customer's order page shows them, and a parcel
-- out for delivery tells its customer to keep the cash ready. See ADR-160 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE orders.fulfillment_events (
  shop_id        uuid        NOT NULL,
  id             uuid        NOT NULL,
  fulfillment_id uuid        NOT NULL,
  status         text        NOT NULL
                 CHECK (status IN ('confirmed', 'in_transit', 'out_for_delivery',
                                   'attempted_delivery', 'delivered', 'returning', 'returned',
                                   'failure')),
  -- The courier's words, "PostEx WareHouse", or the shop's own; cleared when the customer's data
  -- is erased.
  message        text        CHECK (char_length(message) BETWEEN 1 AND 200),
  happened_at    timestamptz NOT NULL,
  -- What it was recorded from, as the courier's change the worker heard: recorded once.
  source_key     text        CHECK (char_length(source_key) BETWEEN 1 AND 200),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, fulfillment_id) REFERENCES orders.fulfillments (shop_id, id)
    ON DELETE CASCADE
);

CREATE INDEX fulfillment_events_parcel_idx
  ON orders.fulfillment_events (shop_id, fulfillment_id, happened_at, id);
CREATE UNIQUE INDEX fulfillment_events_source_key
  ON orders.fulfillment_events (shop_id, source_key) WHERE source_key IS NOT NULL;

SELECT platform.enable_tenant_isolation('orders.fulfillment_events');
