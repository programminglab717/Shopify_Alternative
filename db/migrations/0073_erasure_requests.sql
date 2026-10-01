-- 0073 · Erasure requests that wait
-- A customer's erasure asked for to happen after a waiting period, which staff can cancel until
-- then; the worker's sweep erases those whose time has come (ADR-110). One per customer: erasing
-- the customer, by the sweep or at once, takes it with them.
CREATE TABLE customers.erasure_requests (
  shop_id      uuid        NOT NULL,
  customer_id  uuid        NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  -- When the sweep may erase them.
  due_at       timestamptz NOT NULL,
  -- Who asked: the audit log names them when the sweep carries the erasure out.
  actor_kind   text        NOT NULL CHECK (actor_kind IN ('app', 'staff')),
  actor_id     uuid        NOT NULL,
  -- The staff member's role at the time; null for apps.
  actor_role   text,
  PRIMARY KEY (shop_id, customer_id),
  FOREIGN KEY (shop_id, customer_id)
    REFERENCES customers.customers (shop_id, id) ON DELETE CASCADE,
  CONSTRAINT erasure_requests_due_check CHECK (due_at > requested_at)
);

SELECT platform.enable_tenant_isolation('customers.erasure_requests');
