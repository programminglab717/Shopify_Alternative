-- 0295 · Store credit refunded keeps the expiry of the credit that paid
-- A refund given as store credit gives back first what the order's own store credit paid, each
-- part with the expiry of the credit it came from, naming that credit. See ADR-661 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE customers.store_credit_transactions
  DROP CONSTRAINT store_credit_transactions_source_check,
  ADD CONSTRAINT store_credit_transactions_source_check
    CHECK (CASE kind
             WHEN 'debit_revert' THEN source_id IS NOT NULL
             WHEN 'expiration' THEN source_id IS NOT NULL
             WHEN 'credit' THEN source_id IS NULL OR event = 'order_refund'
             ELSE source_id IS NULL
           END);

-- What a credit has had given back by refunds of the orders it paid.
CREATE INDEX store_credit_transactions_restored_idx
  ON customers.store_credit_transactions (shop_id, source_id)
  WHERE kind = 'credit' AND source_id IS NOT NULL;
