-- 0172 · Packers' performance
-- How many orders each member of staff, or app, packed over a period (APP-04, COD-11), worked out
-- when asked from the orders' timelines, which this index finds packing in by when it happened:
-- an order's timeline has many entries, one or two of them its packing. See ADR-376 in
-- docs/architecture/13-decision-log.md.

CREATE INDEX order_events_packed_idx ON orders.order_events (shop_id, created_at)
  WHERE kind = 'packed' AND actor_kind IN ('staff', 'app');
