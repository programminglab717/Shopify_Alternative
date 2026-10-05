-- 0128 · The desk waiting for the reminder's answer
-- A shop's Confirmation Desk may wait for its customers to answer on WhatsApp (COD-01, COD-04): an
-- ordinary order paid on delivery is dealt for its first call an hour after its customer was asked
-- again to confirm it, not as it is placed. See ADR-203 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.order_settings
  ADD COLUMN desk_waits_for_reminder boolean NOT NULL DEFAULT false;
