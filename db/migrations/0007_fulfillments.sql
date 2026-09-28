-- 0007 · Fulfillments
-- Parcels: what shipped, with which courier, and what became of it. A parcel is in transit,
-- delivered, returning (refused or undeliverable: return to origin) or returned (checked back
-- in, its items restocked or written off). See docs/architecture/06-orders-fulfillment-logistics.md.

CREATE TABLE orders.fulfillments (
  shop_id          uuid        NOT NULL,
  id               uuid        NOT NULL,
  order_id         uuid        NOT NULL,
  -- Where it shipped from: the order's location.
  location_id      uuid        NOT NULL,
  status           text        NOT NULL DEFAULT 'in_transit'
                   CHECK (status IN ('in_transit', 'delivered', 'returning', 'returned')),
  tracking_company text        CHECK (length(tracking_company) BETWEEN 1 AND 100),
  tracking_number  text        CHECK (length(tracking_number) BETWEEN 1 AND 100),
  tracking_url     text        CHECK (tracking_url ~ '^https://' AND length(tracking_url) <= 2048),
  shipped_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz,
  returning_at     timestamptz,
  returned_at      timestamptz,
  version          integer     NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  CONSTRAINT fulfillments_delivered_check CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  CONSTRAINT fulfillments_returned_check CHECK ((status = 'returned') = (returned_at IS NOT NULL)),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders.orders (shop_id, id) ON DELETE CASCADE
);

CREATE INDEX fulfillments_order_idx ON orders.fulfillments (shop_id, order_id);
-- Staff find orders by the tracking number on a parcel.
CREATE INDEX fulfillments_tracking_idx ON orders.fulfillments (shop_id, tracking_number)
  WHERE tracking_number IS NOT NULL;

SELECT platform.enable_tenant_isolation('orders.fulfillments');

-- What each parcel holds. Once it comes back, how many went back on the shelf; the rest were
-- written off as damaged.
CREATE TABLE orders.fulfillment_lines (
  shop_id            uuid    NOT NULL,
  fulfillment_id     uuid    NOT NULL,
  line_id            uuid    NOT NULL,
  quantity           integer NOT NULL CHECK (quantity > 0),
  restocked_quantity integer CHECK (restocked_quantity >= 0),
  PRIMARY KEY (shop_id, fulfillment_id, line_id),
  CONSTRAINT fulfillment_lines_restocked_check CHECK (restocked_quantity <= quantity),
  FOREIGN KEY (shop_id, fulfillment_id) REFERENCES orders.fulfillments (shop_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (shop_id, line_id) REFERENCES orders.lines (shop_id, id) ON DELETE CASCADE
);

CREATE INDEX fulfillment_lines_line_idx ON orders.fulfillment_lines (shop_id, line_id);

SELECT platform.enable_tenant_isolation('orders.fulfillment_lines');

-- Units of each line shipped so far, kept by every shipment, so what is left to ship is one
-- subtraction.
ALTER TABLE orders.lines
  ADD COLUMN fulfilled_quantity integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT lines_fulfilled_check CHECK (fulfilled_quantity BETWEEN 0 AND quantity);
