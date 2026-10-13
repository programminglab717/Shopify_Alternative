-- 0184 · Repeat orders caught
-- An order placed by a number that has an order not yet shipped, with items in common, placed in
-- the days before, names that order as the one it may repeat (CHK-11): staff merge it in, cancel
-- it as a repeat, or keep both. See ADR-392 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.orders
  ADD COLUMN repeat_of_id uuid,
  DROP CONSTRAINT orders_cancel_reason_check,
  ADD CONSTRAINT orders_cancel_reason_check
    CHECK (cancel_reason IN ('customer', 'no_response', 'fraud', 'inventory', 'other', 'merged',
                             'unpaid', 'duplicate'));
