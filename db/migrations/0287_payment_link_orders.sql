-- 0287 · A payment link's orders
-- A payment link lists the orders placed through it, the latest first (ADR-645): its checkouts
-- that became orders, found by the link. See ADR-645 in docs/architecture/13-decision-log.md.

CREATE INDEX checkouts_payment_link_orders_idx
  ON checkout.checkouts (shop_id, payment_link_id, completed_at DESC)
  WHERE payment_link_id IS NOT NULL AND order_id IS NOT NULL;
