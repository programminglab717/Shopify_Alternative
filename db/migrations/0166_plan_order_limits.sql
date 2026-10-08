-- 0166 · Orders past the Free plan's month
-- An order placed while the shop's plan limits its orders a month (Free, 50) counts toward the
-- month it was placed in, in the shop's time zone, until it is cancelled. One past the limit is
-- taken all the same, its customer none the wiser, but staff see its customer hidden and cannot
-- confirm, pack, book or ship it until the shop's plan has room for it: a bigger plan frees them
-- all, and a counted order cancelled frees its place for the month's earliest past the limit
-- (BIL-01). See ADR-263 in docs/architecture/13-decision-log.md.

ALTER TABLE orders.orders
  -- The first day of the month whose limit the order counts toward, in the shop's time zone; null
  -- for one placed while the shop's plan set no limit, a split's part and an exchange.
  ADD COLUMN plan_month    date,
  -- When it came in past its month's limit, until the shop's plan has room for it; null otherwise.
  ADD COLUMN over_limit_at timestamptz,
  ADD CONSTRAINT orders_over_limit_month CHECK (over_limit_at IS NULL OR plan_month IS NOT NULL);

-- The orders counted toward each month, as each order placed counts them.
CREATE INDEX orders_plan_month_idx ON orders.orders (shop_id, plan_month)
  WHERE plan_month IS NOT NULL;

-- A counted order cancelled, whichever way: the month's earliest order past the limit takes its
-- place.
CREATE FUNCTION orders.free_plan_place() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE orders.orders o
     SET over_limit_at = NULL, version = o.version + 1, updated_at = now()
   WHERE o.shop_id = NEW.shop_id
     AND o.id = (SELECT e.id FROM orders.orders e
                  WHERE e.shop_id = NEW.shop_id AND e.plan_month = NEW.plan_month
                    AND e.over_limit_at IS NOT NULL AND e.status <> 'cancelled'
                  ORDER BY e.number
                  LIMIT 1);
  RETURN NULL;
END
$$;

CREATE TRIGGER plan_place_freed
  AFTER UPDATE OF status ON orders.orders
  FOR EACH ROW
  WHEN (NEW.status = 'cancelled' AND OLD.status <> 'cancelled'
        AND NEW.plan_month IS NOT NULL AND NEW.over_limit_at IS NULL)
  EXECUTE FUNCTION orders.free_plan_place();
