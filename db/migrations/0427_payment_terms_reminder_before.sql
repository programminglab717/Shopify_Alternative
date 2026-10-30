-- 0427 · How long before the due date payment terms are first reminded (CUS-06)
-- A shop chooses the days before an order on terms falls due that its customer is first
-- reminded, 1 to 7, or 0 for no reminder before it: three, as ADR-945 had it, unless it says
-- otherwise. See ADR-965 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.order_settings
  ADD COLUMN terms_before_days smallint NOT NULL DEFAULT 3
    CHECK (terms_before_days BETWEEN 0 AND 7);
