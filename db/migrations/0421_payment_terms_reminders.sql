-- 0421 · Payment terms reminded to the customer (CUS-06)
-- An order on payment terms (ADR-888) still owed is reminded to its customer twice at most:
-- before its due date, and once it is past it. `terms_reminded` says how far: 0 none yet, 1 the
-- reminder before, 2 the one after. See ADR-945 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.orders
  ADD COLUMN terms_reminded smallint NOT NULL DEFAULT 0
    CHECK (terms_reminded BETWEEN 0 AND 2);

-- The orders a sweep looks at: on terms, not reminded twice yet.
CREATE INDEX orders_terms_reminders ON orders.orders (payment_due_at)
  WHERE payment_due_at IS NOT NULL AND terms_reminded < 2;
