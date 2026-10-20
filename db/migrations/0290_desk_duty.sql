-- 0290 · Agents on duty at the Confirmation Desk
-- A member of staff starts a shift at the desk for some hours; where the shop shares new orders
-- out (share_new_orders), each order placed that needs a call is given to the agent on duty with
-- the fewest such orders already, the one given one longest ago first. See ADR-654 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE orders.desk_duty (
  shop_id         uuid        NOT NULL,
  staff_member_id uuid        NOT NULL,
  name            text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  started_at      timestamptz NOT NULL DEFAULT now(),
  ends_at         timestamptz NOT NULL CHECK (ends_at > started_at),
  last_given_at   timestamptz,
  PRIMARY KEY (shop_id, staff_member_id)
);

SELECT platform.enable_tenant_isolation('orders.desk_duty');

ALTER TABLE orders.order_settings
  ADD COLUMN share_new_orders boolean NOT NULL DEFAULT false;
