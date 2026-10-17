-- TCS's statuses, as its tracking says them (SHP-01, ADR-509). A status no row names, and that is
-- not written as Hatti names its own, is asked about again as one on its way: a status TCS adds
-- waits for its row.
INSERT INTO logistics.courier_statuses (courier, raw, status) VALUES
  ('tcs', 'booked', 'booked'),
  ('tcs', 'shipment booked', 'booked'),
  ('tcs', 'picked up', 'in_transit'),
  ('tcs', 'arrived at tcs facility', 'in_transit'),
  ('tcs', 'departed from tcs facility', 'in_transit'),
  ('tcs', 'arrived at origin', 'in_transit'),
  ('tcs', 'departed from origin', 'in_transit'),
  ('tcs', 'arrived at destination', 'in_transit'),
  ('tcs', 'in transit', 'in_transit'),
  ('tcs', 'misrouted', 'in_transit'),
  ('tcs', 'out for delivery', 'out_for_delivery'),
  ('tcs', 'consignee not available', 'attempted'),
  ('tcs', 'address not found', 'attempted'),
  ('tcs', 'incomplete address', 'attempted'),
  ('tcs', 'refused by consignee', 'attempted'),
  ('tcs', 'undelivered', 'attempted'),
  ('tcs', 'shipment on hold', 'attempted'),
  ('tcs', 'delivered', 'delivered'),
  ('tcs', 'return in process', 'returning'),
  ('tcs', 'return to origin', 'returning'),
  ('tcs', 'returned to shipper', 'returned'),
  ('tcs', 'return delivered to shipper', 'returned'),
  ('tcs', 'lost', 'lost'),
  ('tcs', 'cancelled', 'cancelled');
