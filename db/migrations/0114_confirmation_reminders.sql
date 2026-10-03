-- 0114 · A reminder to confirm
-- A cash-on-delivery order still waiting for its customer's answer some hours after it was placed
-- asks them once more, in the shop's calling hours (COD-01): when, so that a sweep asks once. The
-- confirmation queue's index finds the orders waiting. See ADR-175 in
-- docs/architecture/13-decision-log.md.

ALTER TABLE orders.orders ADD COLUMN confirmation_reminded_at timestamptz;
