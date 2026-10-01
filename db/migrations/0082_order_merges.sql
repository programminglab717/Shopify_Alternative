-- 0082 · Orders merged into another
-- An order its customer placed twice joins the other while both wait to be packed (ORD-04,
-- ADR-132): the order merged into takes its items, and it is cancelled as merged, naming that
-- order. Merged orders are left out of what counts a customer's orders and of COD health, since
-- the customer placed one order, not two.

ALTER TABLE orders.orders
  DROP CONSTRAINT orders_cancel_reason_check,
  ADD CONSTRAINT orders_cancel_reason_check
    CHECK (cancel_reason IN ('customer', 'no_response', 'fraud', 'inventory', 'other', 'merged')),
  ADD COLUMN merged_into_id uuid,
  ADD CONSTRAINT orders_merged_into_fkey
    FOREIGN KEY (shop_id, merged_into_id) REFERENCES orders.orders (shop_id, id),
  ADD CONSTRAINT orders_merged_check
    CHECK ((merged_into_id IS NOT NULL) = (cancel_reason IS NOT DISTINCT FROM 'merged')
           AND merged_into_id IS DISTINCT FROM id);
