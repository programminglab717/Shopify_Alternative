-- 0053 · An advance on cash on delivery
-- A cash-on-delivery order may ask for part of its total in advance, by bank transfer, before it
-- ships (CHK-07): it waits for the advance at `awaiting_payment`, as a transfer waits for its
-- money, keeping the account its customer was told to pay into; the courier collects the rest.
-- See ADR-083 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.orders
  -- Minor units; zero for none. Received, it counts in amount_paid.
  ADD COLUMN advance_due bigint NOT NULL DEFAULT 0 CHECK (advance_due >= 0),
  ADD CONSTRAINT orders_advance_due_method_check
      CHECK (advance_due = 0 OR (payment_method = 'cash_on_delivery' AND advance_due <= total));

-- The account an advance is paid into is kept as a transfer's is.
ALTER TABLE orders.orders DROP CONSTRAINT orders_bank_account_check;
ALTER TABLE orders.orders
  ADD CONSTRAINT orders_bank_account_check
      CHECK (bank_account IS NULL OR ((payment_method = 'bank_transfer' OR advance_due > 0)
                                      AND jsonb_typeof(bank_account) = 'object'));
