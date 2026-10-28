-- 0382 · Orders paid at the till (POS-06, POS-08)
-- Money taken at a register for an order, not a till sale: what a click-and-collect order still
-- owed as its customer collected it there, or what a customer paid at the counter for an order
-- sent to their home, in full or as its advance. Kept with the register's session, so that its
-- Z report counts it, and its drawer the cash. See ADR-873 in docs/architecture/13-decision-log.md.

CREATE TABLE orders.pos_order_payments (
  shop_id    uuid        NOT NULL,
  id         uuid        NOT NULL,
  session_id uuid        NOT NULL,
  -- No foreign key: an order may be erased of its customer, and is kept.
  order_id   uuid        NOT NULL,
  -- Collected with its order, or paid for an order sent home.
  kind       text        NOT NULL CHECK (kind IN ('pickup', 'delivery')),
  method     text        NOT NULL CHECK (method IN ('cash', 'card', 'bank_transfer', 'wallet')),
  amount     bigint      NOT NULL CHECK (amount > 0),
  reference  text        CHECK (length(reference) <= 100),
  actor_kind text        NOT NULL CHECK (actor_kind IN ('app', 'staff')),
  actor_id   uuid        NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, session_id) REFERENCES orders.pos_sessions (shop_id, id)
);

SELECT platform.enable_tenant_isolation('orders.pos_order_payments');

CREATE INDEX pos_order_payments_session ON orders.pos_order_payments (shop_id, session_id);
