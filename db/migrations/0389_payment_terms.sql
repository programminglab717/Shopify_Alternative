-- 0389 · Payment terms for wholesale customers
-- A wholesale customer may pay for an order some days after it is placed, by transfer (CUS-06):
-- net 7 to net 120. Such an order ships without waiting for the money, and is owed until paid,
-- overdue past its due date. A price list may give its customers their terms, and a draft the
-- terms its customer agreed. See ADR-888 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.orders
  ADD COLUMN payment_terms_days smallint CHECK (payment_terms_days BETWEEN 1 AND 120),
  ADD COLUMN payment_due_at timestamptz,
  ADD CONSTRAINT orders_payment_terms_due
    CHECK ((payment_terms_days IS NULL) = (payment_due_at IS NULL));

CREATE INDEX orders_payment_due ON orders.orders (shop_id, payment_due_at)
  WHERE payment_due_at IS NOT NULL;

ALTER TABLE orders.draft_orders
  ADD COLUMN payment_terms_days smallint CHECK (payment_terms_days BETWEEN 1 AND 120);

ALTER TABLE pricing.price_lists
  ADD COLUMN payment_terms_days smallint CHECK (payment_terms_days BETWEEN 1 AND 120);
