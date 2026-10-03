-- 0113 · A reminder before an unpaid order is cancelled
-- An order still waiting for its payment, in a shop that cancels such orders after some days
-- (ADR-168), reminds its customer once, a day before its days run out (PAY-01, PAY-02): when, so
-- that a sweep reminds it once. See ADR-174 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.orders ADD COLUMN payment_reminded_at timestamptz;
