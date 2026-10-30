-- 0428 · Customers kept out of payment terms reminders
-- A shop may keep a wholesale customer it knows well from being reminded of its orders on payment
-- terms (CUS-06): a row here means none of their orders is reminded, before or past the date.
-- See ADR-969 in docs/architecture/13-decision-log.md.

CREATE TABLE orders.terms_reminders_off (
  shop_id     uuid        NOT NULL,
  customer_id uuid        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, customer_id)
);

SELECT platform.enable_tenant_isolation('orders.terms_reminders_off');
