-- 0084 · Customer returns
-- A customer sends back items of a delivered parcel, as when a size is wrong (ORD-07, ADR-136):
-- staff record the return, each item with its reason, and check it in when it arrives, each unit
-- back in stock where it came back to or written off. Money given back stays a refund of its own
-- (ADR-029). A refused parcel comes back as the parcel it was, not as a return.

CREATE TABLE orders.returns (
  shop_id          uuid        NOT NULL,
  id               uuid        NOT NULL,
  order_id         uuid        NOT NULL,
  -- The order's first return is 1, named #1001-R1.
  number           integer     NOT NULL CHECK (number > 0),
  status           text        NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'closed', 'cancelled')),
  -- Where its items come back to, and go back in stock.
  location_id      uuid        NOT NULL,
  -- How it comes back, when a courier brings it.
  tracking_company text        CHECK (length(tracking_company) BETWEEN 1 AND 100),
  tracking_number  text        CHECK (length(tracking_number) BETWEEN 1 AND 100),
  -- Cleared when the customer's data is erased.
  note             text        NOT NULL DEFAULT '' CHECK (length(note) <= 5000),
  actor_kind       text        NOT NULL CHECK (actor_kind IN ('app', 'staff')),
  actor_id         uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  cancelled_at     timestamptz,
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, order_id, number),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders.orders (shop_id, id) ON DELETE CASCADE,
  CONSTRAINT returns_closed_check CHECK ((closed_at IS NOT NULL) = (status = 'closed')),
  CONSTRAINT returns_cancelled_check CHECK ((cancelled_at IS NOT NULL) = (status = 'cancelled'))
);

SELECT platform.enable_tenant_isolation('orders.returns');

CREATE TABLE orders.return_lines (
  shop_id            uuid    NOT NULL,
  return_id          uuid    NOT NULL,
  line_id            uuid    NOT NULL,
  quantity           integer NOT NULL CHECK (quantity > 0),
  reason             text    NOT NULL
                     CHECK (reason IN ('size_too_small', 'size_too_large', 'unwanted',
                                       'not_as_described', 'wrong_item', 'defective', 'other')),
  -- Units back in stock once it is checked in; the rest were written off.
  restocked_quantity integer CHECK (restocked_quantity >= 0),
  PRIMARY KEY (shop_id, return_id, line_id),
  CONSTRAINT return_lines_restocked_check CHECK (restocked_quantity <= quantity),
  FOREIGN KEY (shop_id, return_id) REFERENCES orders.returns (shop_id, id) ON DELETE CASCADE,
  FOREIGN KEY (shop_id, line_id) REFERENCES orders.lines (shop_id, id) ON DELETE CASCADE
);

SELECT platform.enable_tenant_isolation('orders.return_lines');
