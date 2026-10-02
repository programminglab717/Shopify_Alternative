-- 0085 · Exchanges
-- A return may send another size at once, as an order of its own (ORD-07, ADR-137): what was paid
-- for the items coming back pays for it as far as it goes, credited from the order they came from
-- as a refund by exchange, in which no money moves; the rest is collected at the door.

ALTER TABLE orders.returns
  ADD COLUMN exchange_order_id uuid,
  -- Orders are not deleted, but if one is, its return keeps what came back.
  ADD CONSTRAINT returns_exchange_order_fkey
    FOREIGN KEY (shop_id, exchange_order_id) REFERENCES orders.orders (shop_id, id)
    ON DELETE SET NULL (exchange_order_id),
  ADD CONSTRAINT returns_exchange_order_key UNIQUE (shop_id, exchange_order_id);

ALTER TABLE orders.refunds
  DROP CONSTRAINT refunds_method_check,
  ADD CONSTRAINT refunds_method_check
    CHECK (method IN ('bank_transfer', 'mobile_wallet', 'cash', 'other', 'exchange'));
