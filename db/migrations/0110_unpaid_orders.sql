-- 0110 · Orders never paid
-- An order waiting for a payment, by transfer or online or an advance asked of it, and still not
-- paid in the days its shop allows is cancelled by the worker, its stock let go (PAY-01, PAY-02).
-- See ADR-168 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.orders
  DROP CONSTRAINT orders_cancel_reason_check,
  ADD CONSTRAINT orders_cancel_reason_check
    CHECK (cancel_reason IN ('customer', 'no_response', 'fraud', 'inventory', 'other', 'merged',
                             'unpaid'));

ALTER TABLE orders.order_settings
  -- Days after an order was placed when, its payment still awaited, it is cancelled; null for
  -- never.
  ADD COLUMN cancel_unpaid_after_days smallint CHECK (cancel_unpaid_after_days BETWEEN 1 AND 30);
