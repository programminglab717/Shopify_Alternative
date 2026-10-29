-- 0403 · Credit limits
-- What a wholesale customer may owe on payment terms at most (CUS-06): an order on terms that
-- would take what they owe past it is refused. See ADR-907 in docs/architecture/13-decision-log.md.

CREATE TABLE orders.credit_limits (
  shop_id      uuid        NOT NULL,
  customer_id  uuid        NOT NULL,
  -- In minor units.
  credit_limit bigint      NOT NULL CHECK (credit_limit > 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, customer_id)
);

SELECT platform.enable_tenant_isolation('orders.credit_limits');
