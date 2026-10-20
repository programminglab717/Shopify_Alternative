-- 0289 · What staff may take off an order
-- The most, as a percentage of what an order's items cost, a member of staff without the
-- give_any_discount capability takes off it on its page or at the desk (ORD-04); null for no
-- limit. See ADR-651 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.order_settings
  ADD COLUMN staff_discount_percent smallint
    CHECK (staff_discount_percent BETWEEN 0 AND 100);
