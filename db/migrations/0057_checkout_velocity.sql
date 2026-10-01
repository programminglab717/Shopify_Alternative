-- 0057 · Limits on how fast checkout takes orders
-- Checkout takes so many orders from one mobile number a day, and from one internet address an
-- hour (CHK-18), counting the orders it placed by the number they go to and the address they
-- came from, which orders keep (ADR-057). See ADR-087 in docs/architecture/13-decision-log.md.

CREATE INDEX orders_client_ip_idx ON orders.orders (shop_id, client_ip, created_at)
  WHERE client_ip IS NOT NULL;
