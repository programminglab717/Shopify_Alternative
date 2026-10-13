-- Local pickup (SHP-15, ADR-389): a location where customers may collect their orders, with what
-- it tells them of it, "Ready in two hours; ask at the counter"; and orders collected there
-- rather than shipped, which wait as ready for pickup once packed.
ALTER TABLE inventory.locations
  ADD COLUMN pickup_enabled      boolean NOT NULL DEFAULT false,
  ADD COLUMN pickup_instructions text    CHECK (char_length(pickup_instructions) BETWEEN 1 AND 200);

ALTER TABLE orders.orders
  ADD COLUMN delivery_method text NOT NULL DEFAULT 'shipping'
             CHECK (delivery_method IN ('shipping', 'pickup'));

ALTER TABLE orders.orders DROP CONSTRAINT orders_stage_check;
ALTER TABLE orders.orders
  ADD CONSTRAINT orders_stage_check
      CHECK (stage IN ('needs_confirmation', 'needs_review', 'awaiting_payment', 'to_pack',
                       'to_book', 'ready_for_pickup', 'partially_fulfilled', 'in_transit',
                       'returning', 'delivered', 'returned', 'lost', 'completed', 'cancelled'));
