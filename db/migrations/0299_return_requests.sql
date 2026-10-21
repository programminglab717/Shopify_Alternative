-- 0299 · Returns shoppers ask for
-- Where the shop takes them, a shopper asks for a return from their delivered order's page within
-- the days the shop allows: which items, why, and whether they want another size, store credit or
-- their money back. Staff approve it, and it becomes the return staff record (ADR-136), or
-- decline it, saying why; the shopper is told either way (ORD-08).
-- See ADR-675 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.order_settings
  -- Days after delivery a shopper may ask for a return from their order's page; null for none.
  -- An order's page lasts 30 days after the order ends, so no more.
  ADD COLUMN return_window_days integer CHECK (return_window_days BETWEEN 1 AND 30);

CREATE TABLE orders.return_requests (
  shop_id            uuid        NOT NULL,
  id                 uuid        NOT NULL,
  order_id           uuid        NOT NULL,
  status             text        NOT NULL DEFAULT 'requested'
                     CHECK (status IN ('requested', 'approved', 'declined')),
  -- What the shopper would like for what they send back.
  preference         text        NOT NULL
                     CHECK (preference IN ('exchange', 'store_credit', 'refund')),
  -- The shopper's own words, such as the size they want instead. Cleared when their data is
  -- erased.
  note               text        NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  -- Why the shop declined it, as the shopper is told.
  decline_reason     text        CHECK (length(decline_reason) BETWEEN 1 AND 500),
  -- The return it became, once approved.
  return_id          uuid,
  decided_actor_kind text        CHECK (decided_actor_kind IN ('app', 'staff')),
  decided_actor_id   uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz,
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders.orders (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, return_id) REFERENCES orders.returns (shop_id, id) ON DELETE SET NULL,
  CONSTRAINT return_requests_decided_check
    CHECK ((decided_at IS NULL) = (status = 'requested')
           AND (decided_actor_kind IS NULL) = (status = 'requested')),
  CONSTRAINT return_requests_declined_check
    CHECK ((decline_reason IS NOT NULL) = (status = 'declined'))
);

-- One request waiting at a time for an order.
CREATE UNIQUE INDEX return_requests_waiting_one ON orders.return_requests (shop_id, order_id)
  WHERE status = 'requested';
-- Those waiting, the oldest first, for staff.
CREATE INDEX return_requests_waiting ON orders.return_requests (shop_id, created_at, id)
  WHERE status = 'requested';

SELECT platform.enable_tenant_isolation('orders.return_requests');

CREATE TABLE orders.return_request_lines (
  shop_id    uuid    NOT NULL,
  request_id uuid    NOT NULL,
  line_id    uuid    NOT NULL,
  quantity   integer NOT NULL CHECK (quantity > 0),
  reason     text    NOT NULL
             CHECK (reason IN ('size_too_small', 'size_too_large', 'unwanted',
                               'not_as_described', 'wrong_item', 'defective', 'other')),
  PRIMARY KEY (shop_id, request_id, line_id),
  FOREIGN KEY (shop_id, request_id) REFERENCES orders.return_requests (shop_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (shop_id, line_id) REFERENCES orders.lines (shop_id, id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('orders.return_request_lines');
