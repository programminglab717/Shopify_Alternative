-- 0296 · Store credit given back in part on cancelling
-- An order whose refunds took part of what its store credit paid gives the rest back when it is
-- cancelled or comes back, as credits that name the credit each restores. See ADR-663 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE customers.store_credit_transactions
  DROP CONSTRAINT store_credit_transactions_source_check,
  ADD CONSTRAINT store_credit_transactions_source_check
    CHECK (CASE kind
             WHEN 'debit_revert' THEN source_id IS NOT NULL
             WHEN 'expiration' THEN source_id IS NOT NULL
             WHEN 'credit' THEN source_id IS NULL OR event IN ('order_refund', 'order_cancellation')
             ELSE source_id IS NULL
           END);
