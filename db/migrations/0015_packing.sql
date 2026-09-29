-- 0015 · Packing
-- Between confirming an order and handing it to a courier, it is packed: the pipeline's "To pack"
-- and "To book" (docs/design/02-information-architecture.md §1). The to_fulfill stage splits in
-- two. See docs/engineering/conventions.md.

-- When the order was marked packed; null while it is not.
ALTER TABLE orders.orders ADD COLUMN packed_at timestamptz;

ALTER TABLE orders.orders DROP CONSTRAINT orders_stage_check;
UPDATE orders.orders SET stage = 'to_pack' WHERE stage = 'to_fulfill';
ALTER TABLE orders.orders
  ADD CONSTRAINT orders_stage_check
      CHECK (stage IN ('needs_confirmation', 'needs_review', 'to_pack', 'to_book',
                       'partially_fulfilled', 'in_transit', 'returning', 'delivered', 'returned',
                       'completed', 'cancelled'));
