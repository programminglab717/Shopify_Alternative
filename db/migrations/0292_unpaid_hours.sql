-- 0292 · Orders never paid cancelled after hours
-- A shop selling online alone cancels an order still unpaid some hours after it was placed,
-- rather than days: one or the other, never both. See ADR-657 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE orders.order_settings
  ADD COLUMN cancel_unpaid_after_hours smallint CHECK (cancel_unpaid_after_hours BETWEEN 1 AND 72),
  ADD CONSTRAINT order_settings_one_unpaid_window
    CHECK (cancel_unpaid_after_days IS NULL OR cancel_unpaid_after_hours IS NULL);
