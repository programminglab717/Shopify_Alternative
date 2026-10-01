-- 0060 · Agents' performance
-- How each agent of the Confirmation Desk did over a period (COD-11): the calls they made, the
-- orders they confirmed and cancelled, and how the orders they confirmed turned out. Worked out
-- when asked from the calls and the orders' timelines, which these indexes find by when they
-- happened: an order's timeline has many entries, few of them an agent settling it. See ADR-090
-- in docs/architecture/13-decision-log.md.

CREATE INDEX order_events_settled_idx ON orders.order_events (shop_id, created_at)
  WHERE kind IN ('confirmed', 'cancelled') AND actor_kind IN ('staff', 'app');

CREATE INDEX confirmation_calls_created_idx ON orders.confirmation_calls (shop_id, created_at);
