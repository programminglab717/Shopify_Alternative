-- 0426 · How often, and how many times, overdue payment terms are reminded (CUS-06)
-- A shop chooses the days between reminders of an order on terms still owed past its date, and
-- how many are sent past it: a week and four, as ADR-954 had them, unless it says otherwise.
-- See ADR-964 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.order_settings
  ADD COLUMN terms_reminder_days smallint NOT NULL DEFAULT 7
    CHECK (terms_reminder_days BETWEEN 1 AND 30),
  ADD COLUMN terms_overdue_reminders smallint NOT NULL DEFAULT 4
    CHECK (terms_overdue_reminders BETWEEN 1 AND 4);
