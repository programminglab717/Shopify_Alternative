-- 0039 · Order settings: how long customers may cancel
-- A shop's policies for its orders, beside its risk policy: first, how long a cash-on-delivery
-- customer may cancel their order through its link (05 §8). Until it is confirmed, as before;
-- or until it is packed, though they confirmed it: a cancellation then costs the shop nothing,
-- and a parcel refused at the door costs it a return. See ADR-068 in
-- docs/architecture/13-decision-log.md.

CREATE TABLE orders.order_settings (
  shop_id               uuid        PRIMARY KEY,
  customer_cancellation text        NOT NULL DEFAULT 'until_packed'
                        CHECK (customer_cancellation IN ('until_confirmed', 'until_packed')),
  version               integer     NOT NULL DEFAULT 1,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

SELECT platform.enable_tenant_isolation('orders.order_settings');
