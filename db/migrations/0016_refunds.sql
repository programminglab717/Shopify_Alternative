-- 0016 · Refunds
-- Money given back on an order: how much, how it went back and why. The order keeps what was
-- refunded beside what was paid, and its financial status follows. See
-- docs/engineering/conventions.md.

ALTER TABLE orders.orders
  ADD COLUMN amount_refunded bigint NOT NULL DEFAULT 0 CHECK (amount_refunded >= 0),
  ADD CONSTRAINT orders_refunded_check CHECK (amount_refunded <= amount_paid);

CREATE TABLE orders.refunds (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL,
  order_id   uuid        NOT NULL,
  -- Minor units of the order's currency.
  amount     bigint      NOT NULL CHECK (amount > 0),
  -- How the money went back. Hatti moves no money yet: staff send it and record it here.
  method     text        NOT NULL
             CHECK (method IN ('bank_transfer', 'mobile_wallet', 'cash', 'other')),
  -- The transfer's reference, such as a JazzCash transaction ID. Cleared when the customer's
  -- data is erased, with the note.
  reference  text        CHECK (length(reference) BETWEEN 1 AND 100),
  note       text        NOT NULL DEFAULT '' CHECK (length(note) <= 5000),
  actor_kind text        NOT NULL CHECK (actor_kind IN ('app', 'staff')),
  -- The access token or the staff member.
  actor_id   uuid        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders.orders (shop_id, id) ON DELETE CASCADE
);

CREATE INDEX refunds_order_idx ON orders.refunds (shop_id, order_id, id);

SELECT platform.enable_tenant_isolation('orders.refunds');
