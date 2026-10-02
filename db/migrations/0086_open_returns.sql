-- 0086 · Returns on their way
-- Customer returns still coming back are listed the longest on its way first, to chase, as
-- parcels coming back are (ADR-138), and counted on the admin's home.

CREATE INDEX returns_open_idx ON orders.returns (shop_id, created_at, id) WHERE status = 'open';
