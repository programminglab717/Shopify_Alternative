-- 0080 · Order assignment
-- An order may be given to a member of staff to see through (ORD-10, ADR-127): who, by their
-- account's ID, and since when. The account is the identity module's, so nothing here refers to
-- it: the core checks that they work in the shop when an order is given to them.

ALTER TABLE orders.orders
  ADD COLUMN assignee_id uuid,
  ADD COLUMN assigned_at timestamptz,
  ADD CONSTRAINT orders_assignee_check CHECK ((assignee_id IS NULL) = (assigned_at IS NULL));

-- Each member of staff's orders, for `assignee:me`: few beside the rest.
CREATE INDEX orders_assignee_idx
  ON orders.orders (shop_id, assignee_id, id DESC)
  WHERE assignee_id IS NOT NULL;
