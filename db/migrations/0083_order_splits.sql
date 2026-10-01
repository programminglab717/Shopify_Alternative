-- 0083 · Orders split in two
-- Lines of a cash-on-delivery order waiting to be packed are sent apart as an order of their own
-- (ORD-04, ADR-135), as when part of it waits for stock: cash on delivery is collected by order,
-- so a part sent apart is one. A part names the order it was split from, the first one when a
-- part is split again, so that risk scores an order and its parts as the one order their
-- customer placed.

ALTER TABLE orders.orders
  ADD COLUMN split_from_id uuid,
  ADD CONSTRAINT orders_split_from_fkey
    FOREIGN KEY (shop_id, split_from_id) REFERENCES orders.orders (shop_id, id),
  ADD CONSTRAINT orders_split_from_check CHECK (split_from_id IS DISTINCT FROM id);
