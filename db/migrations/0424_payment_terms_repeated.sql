-- 0424 · Overdue payment terms reminded weekly (CUS-06)
-- An order on payment terms still owed past its date (ADR-945) is reminded again each week, four
-- times at most past the date: `terms_reminded` counts to 5 (1 the reminder before, 2 to 5 those
-- after), and `terms_reminded_at` says when the last went. Those reminded already count from now.
-- See ADR-954 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.orders DROP CONSTRAINT orders_terms_reminded_check;
ALTER TABLE orders.orders
  ADD CONSTRAINT orders_terms_reminded_check CHECK (terms_reminded BETWEEN 0 AND 5),
  ADD COLUMN terms_reminded_at timestamptz;

UPDATE orders.orders SET terms_reminded_at = now() WHERE terms_reminded > 0;

DROP INDEX orders.orders_terms_reminders;
CREATE INDEX orders_terms_reminders ON orders.orders (payment_due_at)
  WHERE payment_due_at IS NOT NULL AND terms_reminded < 5;
