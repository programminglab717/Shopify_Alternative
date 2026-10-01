-- 0062 · Giving up on customers who can't be reached
-- A shop may cancel the orders whose customers could not be reached, three calls unanswered, once
-- they have waited as many days as it says (COD-05): a sweep in the worker cancels them, shop by
-- shop, letting their stock go. See ADR-092 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.order_settings
  -- Days after an order was placed; null for never.
  ADD COLUMN cancel_unreachable_after_days smallint
    CHECK (cancel_unreachable_after_days BETWEEN 1 AND 30);
