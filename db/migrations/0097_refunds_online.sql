-- 0097 · Refunds online
-- Money a customer paid online goes back through the gateway that took it, where the gateway's
-- API gives refunds (PAY-06): each refund is recorded before the gateway is asked, then marked
-- refunded, refused, or unknown when no answer came; a refunded one is written on its order as a
-- refund of its own, with the gateway's reference. See ADR-153 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE orders.refunds
  DROP CONSTRAINT refunds_method_check,
  ADD CONSTRAINT refunds_method_check
    CHECK (method IN ('bank_transfer', 'mobile_wallet', 'cash', 'other', 'exchange', 'online'));

CREATE TABLE payments.refunds (
  shop_id     uuid        NOT NULL,
  id          uuid        NOT NULL DEFAULT platform.uuidv7(),
  -- The payment it gives back of, and that payment's order.
  session_id  uuid        NOT NULL,
  order_id    uuid        NOT NULL,
  -- Minor units, in the payment's currency.
  amount      bigint      NOT NULL CHECK (amount > 0),
  -- Pending while the gateway is asked; then refunded, refused, or unknown when it did not
  -- answer, which staff check in the gateway's dashboard. Pending and unknown ones hold what they
  -- asked for, so that nothing is given back twice.
  status      text        NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'refunded', 'refused', 'unknown')),
  -- Once refunded: the gateway's reference for it, and the order's refund it was written as.
  reference   text        CHECK (char_length(reference) <= 200),
  refund_id   uuid,
  -- Why the gateway refused it, or why no answer came.
  error       text        CHECK (char_length(error) <= 1000),
  actor_kind  text        NOT NULL CHECK (actor_kind IN ('app', 'staff')),
  actor_id    uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, id),
  FOREIGN KEY (shop_id, session_id) REFERENCES payments.sessions (shop_id, id),
  CHECK (status = 'refunded' OR refund_id IS NULL)
);

SELECT platform.enable_tenant_isolation('payments.refunds');

CREATE INDEX refunds_session ON payments.refunds (shop_id, session_id, created_at);
