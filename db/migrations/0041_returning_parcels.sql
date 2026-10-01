-- 0041 · Parcels coming back, by how long
-- Parcels on their way back are listed the longest on its way first, for chasing their couriers
-- (COD-09): an index of those alone, as they are few beside the parcels delivered. See ADR-071 in
-- docs/architecture/13-decision-log.md.

CREATE INDEX fulfillments_returning_idx
  ON orders.fulfillments (shop_id, returning_at, id)
  WHERE status = 'returning';
