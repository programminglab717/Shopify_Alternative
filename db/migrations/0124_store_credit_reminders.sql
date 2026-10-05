-- 0124 · Customers told of their store credit (ORD-09)
-- A credit with something left is the customer's to be reminded of once, a week before it
-- expires: the worker's sweep marks it as it records the reminder, so that no sweep after
-- reminds them again.
-- See ADR-192 in docs/architecture/13-decision-log.md.

ALTER TABLE customers.store_credit_transactions
  ADD COLUMN expiry_reminded_at timestamptz,
  ADD CONSTRAINT store_credit_transactions_reminded_check
    CHECK (expiry_reminded_at IS NULL OR (kind = 'credit' AND expires_at IS NOT NULL));

-- The credits the sweep has still to remind of, by when they expire.
CREATE INDEX store_credit_transactions_reminding_idx
  ON customers.store_credit_transactions (expires_at)
  WHERE kind = 'credit' AND remaining > 0 AND expires_at IS NOT NULL
    AND expiry_reminded_at IS NULL;

-- Request code marks a credit reminded of, as it spends credits; it rewrites nothing else.
GRANT UPDATE (expiry_reminded_at) ON customers.store_credit_transactions TO hatti_app_role;
