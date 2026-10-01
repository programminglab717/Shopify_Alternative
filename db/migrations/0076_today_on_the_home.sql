-- 0076 · Today on the home
-- The home says how the shop's day has gone (ANL-01): the orders placed since its midnight, and
-- the parcels delivered and turned back since. Each is read on every load of the home, so each has
-- an index; the orders' also serves sales reports and COD health over short periods. See ADR-121
-- in docs/architecture/13-decision-log.md.

CREATE INDEX orders_created_idx ON orders.orders (shop_id, created_at);

CREATE INDEX fulfillments_delivered_idx
  ON orders.fulfillments (shop_id, delivered_at)
  WHERE delivered_at IS NOT NULL;

CREATE INDEX fulfillments_turned_back_idx
  ON orders.fulfillments (shop_id, returning_at)
  WHERE returning_at IS NOT NULL;
